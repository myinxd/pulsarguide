import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';

export async function GET(context) {
  const blogPosts = await getCollection('blog');
  const paperNotes = await getCollection('paperNotes');

  const items = [
    ...blogPosts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/blog/${post.slug}/`,
    })),
    ...paperNotes.map((note) => ({
      title: `[论文笔记] ${note.data.title}`,
      description: note.data.description,
      pubDate: note.data.pubDate,
      link: `/paper-notes/${note.slug}/`,
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
