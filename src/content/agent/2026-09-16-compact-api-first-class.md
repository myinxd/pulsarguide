---
title: "compact 进协议了：上下文压缩从 CLI 技巧变成 API 能力"
description: "长跑 Agent 绕不过去的一环是上下文压缩。Anthropic 把这件事从 Claude Code 的内部机制，升级成了 Messages API 里的一等公民——compact_20260112。这篇讲清楚它的协议设计（compaction block 为什么必须回传）、一个能让你的成本账全算错的 usage 陷阱，以及 SDK 方案被废弃说明了什么。"
pubDate: 2026-09-16T16:00:00+08:00
tags:
  - Agent
  - 上下文压缩
  - Compaction
  - API
  - Claude Code
series:
  key: context-engineering
  title: 上下文工程
  order: 1
---

> 你写了个长跑 agent，跑到第 80 轮。模型突然忘了你在第 3 轮反复强调过的那条约束。
> 你以为是自己 prompt 写得不好，其实它早就压缩过了——压缩在什么时候发生、压掉的是什么，你既没被告知，也没有任何接口能问。
> 更尴尬的是，等你想给这件事加个监控，你发现压缩压根不在协议里。你在外面看不到任何信号。

这是很长一段时间里，所有搭长会话 agent 的人都得忍的一件事：**上下文压缩是个隐式副作用**。它由 CLI 或框架在背后决定，你只能事后从「模型怎么变笨了」倒推。

情况在变。Anthropic 把压缩搬进了 Messages API——`compact_20260112`，一个可以显式开启、可以配置阈值、可以在响应里拿到结果的编辑策略。压缩从「框架的内部实现」变成了「协议的一等公民」。

这篇文章讲三件事：它的协议是怎么设计的，一个会让你成本核算全错的坑，以及它和老的 SDK 方案对比说明了什么。

## 一、先把三层 compact 分清

聊这个话题最容易出错的地方，是把三层不同的东西混成一件。这三层的可见度差别很大：

| 层 | 是什么 | 谁能看到 |
|---|---|---|
| **内部流水线** | Claude Code CLI 里的多层压缩机制，用户完全无感 | 只存在于源码和逆向报告里 |
| **用户控制面** | `/compact`、`/autocompact`、`/rewind`、CLAUDE.md 里的 Compact instructions 段、PreCompact hook | 有完整文档 |
| **API 能力** | 服务端压缩 `compact_20260112` | 有完整文档 |

三层里只有第一层是「黑箱」。而它之所以被知道，是因为一次事故：2026 年 3 月，`@anthropic-ai/claude-code` 的一个 npm 版本把 `.npmignore` 配漏了，打包带进去一份约 60MB 的 sourcemap。sourcemap 的 `sourcesContent` 字段完整存着原始 TypeScript，于是约 1,900 个文件、51 万行源码就这么公开了。

> 顺带说一句这个事故的反讽程度：Claude Code 内部有一个 Undercover Mode，专门用来防止它自己在开源仓库里泄露 Anthropic 的内部信息。结果整个源码通过一个构建产物向全世界公开了。

今天关于「多层压缩流水线」的所有知识都来自那次泄漏及后续的逆向分析（包括 UCL 的论文《Dive into Claude Code》），**不是官方文档**。所以本文凡是涉及内部机制的描述，都会明确标注来源。第二层和第三层则可以放心引用。

## 二、服务端压缩长什么样

启用方式很简单，往 `context_management.edits` 里塞一条策略：

```python
response = client.beta.messages.create(
    betas=["compact-2026-01-12"],
    model="claude-opus-4-8",
    max_tokens=4096,
    messages=messages,
    context_management={"edits": [{"type": "compact_20260112"}]},
)
```

需要带上 beta 头 `compact-2026-01-12`。参数一共四个：

| 参数 | 默认 | 说明 |
|---|---|---|
| `type` | 必填 | 固定为 `"compact_20260112"` |
| `trigger` | `{"type": "input_tokens", "value": 150000}` | `input_tokens` 是**唯一**支持的触发类型；value 最小 50,000 |
| `pause_after_compaction` | `false` | 生成摘要后暂停，让你有机会插内容再继续 |
| `instructions` | `null` | 自定义摘要提示，**完全替换**默认提示（不是补充） |

几个值得注意的设计选择。

**触发条件只给了 `input_tokens`。** 对比一下同一套 API 里的 `clear_tool_uses_20250919`，那个是同时支持 `input_tokens` 和 `tool_uses` 两种触发类型的。压缩只留了一种，说明 Anthropic 认为「按 token 数触发摘要」这件事的语义足够明确，不需要按工具调用次数来近似。

**默认阈值 150K，下限 50K。** 这个下限比看起来讲究——它其实是在防你手滑写出 `{"value": 1000}` 这种配置，导致每次都压、每次都压不出东西。

**摘要只能用请求里指定的那个模型。** 这是当前的明确限制：你不能说「主任务走 Opus，摘要走 Haiku」。老的 SDK 方案是支持 `model` 参数的，服务端方案反而收紧了。这是一处让我意外的取舍——省钱的诉求被放在了「摘要质量一致性」之后。

**支持范围**：Fable 5、Mythos 5、Mythos Preview、Opus 4.8 / 4.7 / 4.6、Sonnet 4.6。在 Amazon Bedrock 上支持 Sonnet 4.6 和 Opus 4.6，但注意 **Converse API 不支持，得走 InvokeModel**。另外这个特性是 ZDR eligible 的，有零数据留存安排的组织的流量不会被留存。

## 三、核心设计：compaction block 必须回传

这是整件事里我认为最值得琢磨的协议设计。

压缩发生时，API 不是悄悄改掉你的历史，而是在 assistant 响应的**开头**放一个内容块：

```json
{
  "content": [
    { "type": "compaction", "content": "Summary of the conversation: ..." },
    { "type": "text", "text": "Based on our conversation so far..." }
  ]
}
```

然后规则只有两条，但两条都很关键：

**第一，客户端必须把这个 block 回传。** 你的循环里只需要一句 `messages.append({"role": "assistant", "content": response.content})`，压缩块就跟着回去了。

**第二，一旦 API 收到 compaction block，它之前的所有内容块全部被丢弃。**

这两条合起来，解释了服务端压缩为什么能比客户端方案干净：**状态的裁剪责任在服务端，客户端只负责如实回传**。你不需要自己写代码去判断「哪些消息该丢」，也不需要维护一份被压过的历史副本。你甚至可以保留完整的原始消息列表不管它——API 会自己忽略掉 compaction block 之前的部分。

这个设计有一个直接后果，我觉得挺优雅：**压缩是幂等的**。重放一个已有的 compaction block 不会产生额外的压缩成本，顶层 usage 字段也依然准确。客户端不需要知道「我上次是不是已经压过了」——这在网络重试、多进程复用同一份历史这类场景下省掉了大量状态管理。

几个配套细节：

- **可以给 compaction block 加 `cache_control`。** 缓存完整 system prompt 加上摘要文本，被压掉的原始内容就被忽略了。压缩之后的第一件事就是把新的 prefix 缓存起来，不然每次压完都吃一次全量 cache_creation。
- **流式响应里，摘要是一次性给的。** 你会收到一个 `content_block_start`，然后**单个** `content_block_delta`（`type` 是 `compaction_delta`，里面是完整的摘要文本），再一个 `content_block_stop`。压缩块不像文本块那样逐 token 流——因为它本质是一份文档，不是生成中的内容。

## 四、那个会让成本账算错的 usage 陷阱

这一段是全文最实用的部分，因为它会静默破坏你现有的成本监控。

**服务端压缩产生的 token 用量，不在顶层的 usage 字段里。**

触发压缩的请求，响应长这样：

```json
{
  "usage": {
    "input_tokens": 45000,
    "output_tokens": 1234,
    "iterations": [
      { "type": "compaction", "input_tokens": 180000, "output_tokens": 3500 },
      { "type": "message",    "input_tokens": 23000,  "output_tokens": 1000 }
    ]
  }
}
```

顶层那两个数字，是**所有非压缩迭代的合计**。那次 180K 输入、3.5K 输出的摘要调用，压根不在里面。

要算总消耗和账单，必须对 `usage.iterations` 求和。规则有四条：

1. **计费要跨 `iterations` 聚合**，不能只看顶层字段。
2. `iterations` **只在本次请求触发了新压缩时才出现**。没压缩的请求不会多这个字段，所以你的代码得能处理它不存在的情况。
3. **重放旧的 compaction block 不产生额外压缩成本**，此时顶层字段是准确的。
4. 如果你现在用 `usage.input_tokens` 做成本追踪、配额分配或者审计报表，**启用压缩的那一刻，这套逻辑就错了**——而且不会报错，只是少算。

最后这条最要命。少算的账不会有人来提醒你，你只会在某个月发现账单和 dashboard 对不上，然后花半天找原因。

顺带提一个能力：**触发检查发生在每个采样迭代开始时**。这意味着如果你同时用了服务端工具（比如 web search），一次请求里可能触发**多次**压缩。结合 `pause_after_compaction` 和一个压缩计数器，你可以做总 token 预算控制——比如每次压缩按触发阈值估算，累计到某个上限就提示模型收尾。这条算是把「长跑任务的成本上限」这件事变得可编程了。

还有个辅助接口：`count_tokens` 端点会**应用已有的 compaction block，但不会触发新的压缩**，并返回 `context_management.original_input_tokens` 让你对比压缩前后的规模。

## 五、SDK 方案被废弃，说明什么

服务端压缩不是 Anthropic 的第一版方案。之前有 `compaction_control`，在 Python / TypeScript / Ruby SDK 的 `tool_runner` 里配置：

| 参数 | 默认 |
|---|---|
| `enabled` | 必填 |
| `context_token_threshold` | 100,000 |
| `model` | 同主模型 |
| `summary_prompt` | 见下 |

SDK 版生成的是一份 **5 段摘要**：Task Overview、Current State、Important Discoveries、Next Steps、Context to Preserve。比内部流水线那份 9 段的模板简洁，但结构是同一套思路——把「用户想干什么、干到哪了、踩过什么坑、下一步是什么」写清楚。

**这个参数已经 deprecated，官方说会在未来版本移除。** 官方给的理由很直接：服务端方案集成复杂度更低、token 计算更准、没有客户端侧的限制。

「token 计算更准」这句不是客套。SDK 方案有个真实的坑：它把 token 用量算成 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens` 直接相加。看着没问题，但一旦用了服务端工具，`cache_read_input_tokens` 会累积多次内部调用的读取量。官方文档里给的例子是：真实上下文 63,000，被算成 `63000 + 270000 = 333,000`——**压缩时机全错**，在还早着的时候就开始压。

这个坑挺有代表性的。**「在客户端估算 token 用量」本身就是个容易做错的事**，因为客户端看不到服务端内部发生了多少次采样。把压缩搬到服务端，等于把「谁最清楚 token 用量」这个问题交还给了唯一知道答案的那一方。

## 六、另一半：清除不是摘要

压缩解决的是「历史太长」，但还有一类问题是「历史里有垃圾」。Anthropic 单独做了一组 context editing 能力（beta 头 `context-management-2025-06-27`），**是清除，不是摘要**：

| 编辑类型 | 作用 |
|---|---|
| `clear_thinking_20251015` | 清除 extended thinking 块。默认等价于保留最近 1 轮，可以设成 `"all"` 全保留 |
| `clear_tool_uses_20250919` | 清除最旧的工具结果，替换为占位文本 |

`clear_tool_uses_20250919` 的几个参数值得单独说：

| 参数 | 默认 | 说明 |
|---|---|---|
| `trigger` | 100,000 input tokens | 支持 `input_tokens` / `tool_uses` 两种类型 |
| `keep` | 保留最近 3 个工具调用对 | 先丢最旧的 |
| `clear_at_least` | 无 | 保证单次至少清除这么多 token，否则**不执行** |
| `exclude_tools` | 无 | 永不清理的工具名单 |
| `clear_tool_inputs` | `false` | 默认只清结果，保留模型的原始调用参数 |

`clear_at_least` 这个参数的设计意图很清楚：清除会让缓存的 prompt 前缀失效，所以要有一个「值不值得破坏缓存」的判断。清除量不够就直接别清，留着缓存。这是个纯经济学参数。

**排序有个硬规则**：两个编辑同时用时，`clear_thinking_20251015` 必须排在 `edits` 数组第一位。

清除和压缩还能和 memory tool 联动——上下文接近清除阈值时，Claude 会收到自动警告，可以在工具结果被清掉**之前**先写进 memory 文件。这就是「压缩前抢救」的官方方案：不是想办法让摘要更准，而是让重要信息换个地方活下来。

## 七、落到你自己：要改哪几行

如果你正在写长跑 agent，这次改动落到代码上是四件事：

1. **加 beta 头，加 edit 配置。** 一行 `context_management`，注意 `trigger` 的 value 有 50,000 下限。
2. **把响应整体 append 回 messages。** 不要只挑 `text` 块塞进去——那样 compaction block 就丢了，压缩状态也就断了。
3. **改成本统计逻辑。** 这是最容易漏的一步。凡是用顶层 `usage.input_tokens` / `output_tokens` 算钱、算配额、出报表的地方，都要改成对 `usage.iterations` 求和，并且处理好这个字段不存在的情况。
4. **给 compaction block 加 `cache_control`。** 压完立刻把新 prefix 缓存起来。

另外提醒一句：**摘要用的是请求里的同一个模型**。如果你指望「压缩一次花不了多少钱」，得先把主模型的单价算进去——那次摘要的输入是整个对话历史。

## 八、和专栏前文的呼应

写到这里，这篇和专栏前几篇其实接上了两条线。

第一条是**可观测性**。9/16 那篇[《同一个 429，三种根因》](/agent/posts/2026-09-16-shared-pipeline-429-503/) 讲多人共享 GPT 管道时，我强调过管道层必须有 dashboard——要采 TPM 消耗、per-user 请求数、429 率，因为没有这些数据运维就是瞎猜。

这篇是同一件事在另一个层面的翻版：**管道层要采 TPM 和 429 率，上下文层要采 `usage.iterations`**。前者管的是「请求发不发得出去」，后者管的是「钱花在哪里」。两处的痛点结构完全一样——关键数据存在，但默认不聚合、不展示，于是没人看，于是出了问题只能靠猜。

第二条是**协议收口**。9/4 那篇[《把 agent 从 Chat Completions 迁到 Responses》](/agent/posts/2026-09-04-migrate-to-responses-api/) 写的是 OpenAI 逼着大家把工具调用、异步、后台任务这些能力从「框架自己想办法」搬进 API 协议。

现在 Anthropic 做的是同一件事，只是搬的是一块别的东西。压缩本来是 harness 的活儿——CLI 在本地判断该不该压、压多少、用什么模板；现在它变成了一个协议字段。**从「模型外面那层壳自己解决」，到「协议直接提供」**，这个迁移路径和当初的工具调用一模一样。

这也是为什么我觉得这件事值得单独写一篇。它不只是多了个参数，而是又一块原本属于 harness 的责任被协议吸收了。而 [harness 系列](/agent/posts/2026-09-02-agent-harness-landscape/) 一直在说「壳比模型值钱」——壳的价值正在被一点点收走，剩下的部分只会越来越贵。

不过协议层解决的是「什么时候压、压多少、钱花在哪」，**它不解决「哪条信息会消失」**。摘要依然是有损的，这件事得换个角度处理。下一篇[《压缩不是备份，是有损摘要》](/agent/posts/2026-09-16-compaction-is-lossy/)接的就是这一面：哪些信息能活过一次压缩、哪些会被静默丢掉，以及怎么把重要规则放到压不掉的位置上。

---

*信息源：本文第二至七章的协议参数、usage 计费规则、SDK 废弃说明与 context editing 规格，均出自 Anthropic 官方文档《Compaction》《Context editing》（beta 头 `compact-2026-01-12` / `context-management-2025-06-27`），并经 AWS Bedrock 的 Claude Messages 压缩说明交叉核对——这部分可直接引用。*

*第一章所述「Claude Code 内部存在多层压缩流水线」以及 2026-03-31 的源码泄漏事实，来自事件发生后的第三方逆向分析（UCL 论文《Dive into Claude Code》，arXiv:2604.14228，以及多篇社区拆解），**非 Anthropic 官方披露**。官方文档从未提及这些内部机制，本文因此不展开其具体阈值与实现细节，请按逆向结论的成色参考。*
