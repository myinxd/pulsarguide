#!/bin/bash
# Pulsar Guide - 部署脚本
# 用法: bash scripts/deploy.sh

set -e

echo "📦 Building Pulsar Guide..."
npm run build

echo ""
echo "🚀 部署方式一: Cloudflare Pages (推荐)"
echo "   1. 访问 https://dash.cloudflare.com/ → Workers & Pages"
echo "   2. 创建新 Pages 项目 → 连接 GitHub 仓库"
echo "   3. 构建命令: npm run build"
echo "   4. 输出目录: dist"
echo "   5. 设置环境变量: NODE_VERSION=22"
echo ""

echo "🚀 部署方式二: GitHub Pages"
echo "   1. 创建 GitHub 仓库 (https://github.com/new)"
echo "   2. 推送代码:"
echo "      git remote add origin https://github.com/你的用户名/pulsarguide.git"
echo "      git push -u origin main"
echo "   3. 仓库 Settings → Pages → 选择 GitHub Actions"
echo ""

echo "🌐 自定义域名: pulsarguide.com"
echo "   在 Cloudflare DNS 添加 CNAME 记录: pulsarguide → pulsarguide.pages.dev"
echo ""

echo "✅ 构建输出: $(du -sh dist | cut -f1)"
