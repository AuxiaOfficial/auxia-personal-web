# Auxia 的个人网站

a new programmer's trying, producted by agent

链接：<https://auxiaweb.pages.dev>

---

线上站点是纯静态的 Cloudflare Pages 项目（`auxiaweb`）。
这个仓库同时包含**站点源码**与**整条构建/自检工具链**。

- 想改站点内容 → 看仓库根的 [`README.md`](../README.md)
- 想了解这套工作流为什么这么设计 → 看 [`WORKFLOW-RETRO-2026-10-02.md`](WORKFLOW-RETRO-2026-10-02.md)

## 30 秒跑起来

```bash
cd auxia-site
python tools/build_site.py     # 装配 dist/
python tools/preview.py        # 本地预览（别直接双击 index.html）
node tools/smoke-test.cjs      # 自检 269 条（需要 jsdom）
```

## 素材说明

背景插画、摄影作品、字体源文件**不随本仓库分发**（体积与版权原因），
本机路径写在 `tools/local.json`（已进 `.gitignore`）。克隆后若要让
`build_gallery.py` 之类的脚本正常工作，自备素材并把路径填进 `tools/local.json`，
或设对应环境变量（`AUXIA_WALLS` / `AUXIA_ILLUST` / `AUXIA_TTF_BODY` 等）。
