import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

// 各集合的文章路由前缀，与 src/pages 下的目录结构保持一致
const ROUTE_PREFIX = {
  blog: '/blog/posts',
  agent: '/agent/posts',
  paperNotes: '/paper-notes/notes',
};

export async function GET(context) {
  const [blogPosts, agentPosts, paperNotes] = await Promise.all([
    getCollection('blog', ({ data }) => !data.draft),
    getCollection('agent', ({ data }) => !data.draft),
    getCollection('paperNotes', ({ data }) => !data.draft),
  ]);

  const items = [
    ...blogPosts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `${ROUTE_PREFIX.blog}/${post.id}/`,
    })),
    ...agentPosts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `${ROUTE_PREFIX.agent}/${post.id}/`,
    })),
    ...paperNotes.map((note) => ({
      title: `[论文笔记] ${note.data.title}`,
      description: note.data.description,
      pubDate: note.data.pubDate,
      link: `${ROUTE_PREFIX.paperNotes}/${note.id}/`,
    })),
  ].sort((a, b) => b.pubDate.valueOf() - a.pubDate.valueOf());

  return rss({
    title: 'Pulsar Guide',
    description: '自动驾驶技术博客 — 论文笔记、工程实践与思考',
    site: context.site,
    items,
    customData: `<language>zh-CN</language>`,
  });
}
