# Changelog

本文件记录项目的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 初始脚手架：项目结构、AI 协作规则、CI 流水线。
- 看板：卡片置顶（永远排在前面）、点击卡片打开详情；详情右上角快速回复，输入时弹出常见回答候选（↑↓ / Enter）；设置中管理常见回答。
- 看板：每条回答 复制 / 收藏 / 重新回答 / 折叠；收藏保存在后端 `favorites` 表（`GET /api/favorites`）。
- 通知等级：普通会话回答完成播放提示音；置顶会话回答完成直接弹窗（后台时用系统通知）。
- 指令 `regenerate` 支持 `answer_index` / `answer_total`，可重新生成指定回答。

### Changed

- “标记完成”改为“归档”：已归档会话不在“全部”及各状态中显示，单独的“已归档”筛选；旧库 `done` 自动迁移为 `archived`。
- 卡片去掉快速回复和“详情”按钮；卡片标题限制为一行。
