# 来源基线

- 来源项目：`publish-hxd1c-running-speed-regulation-training-pages`
- 来源分支：`main`
- 来源提交：`af1cb28dbde01c20cdb31392271215b06ff7ca6b`
- 派生日期：2026-10-24
- 一段制动基线项目：`publish-hxd1c-terminal-stopping-training-pages`
- 独立两段制动项目：`publish-hxd1c-two-stage-terminal-stopping-training-pages`

本项目复制来源项目的 HXD1C 驾驶台图像、LKJ 设备资源、Three.js 运行库和线路场景资源。终到站业务参数、动力学、训练提示、评分状态机、移动端控制和页面入口均在新项目内重新实现。

终到场景使用原游戏 `NEIYI` 路线的大山铺站区段：

- 原始回滚版本站台模型：`platform-300m-no-awning.s`，场景 UID `50695`，源线路里程约 `29373.7–29683.7 m`。
- 当前教学版本以原游戏 `platform-300m-no-awning.s` 派生约 102 m 的短段，沿本股道曲线连续布置 5 段，有效范围约 `29547.1–30049.1 m`；避免直接使用 `platform-500m.s` 时只见雨棚、站台面中断。
- LKJ进站、出站目标分别绑定原线路地面对象 UID `51755`（`jinzhan.s`）和 UID `51674`（`chuzhan-halfauto.s`）。
- 场景窗口：源线路里程 `27900–30550 m`，保留窗口内原轨道、接触网、信号、站房、建筑、道路和植被对象。
- 网页不再下载全线 8339 个场景实例，而是由 `tools/build-terminal-scene-subset.mjs` 生成当前站场窗口专用资源；当前保留 673 个实例、83 个模型定义，并使用预对齐 TrackDB 路径保持原线路累计里程不变。
- 地形：由原路线 `TILES` 中 6 块地形按 `129×129` 网格导出；该分辨率避免移动端/WebGL 16 位索引上限，同时保留约 16 m 地形采样间距。
- 原始游戏目录只用于离线导出；网页运行时仅读取本项目内资产。

一段制动项目在复制时工作树干净，基线提交为 `d65335a`。本项目拥有独立 `.git`、包名、端口和浏览器存储前缀；不回写一段制动项目。
