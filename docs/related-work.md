# 与现有开源自动化科研方案的比较

核对日期：2026-10-21。范围为以下官方仓库、文档及原始论文，不是对全部开源项目的穷尽检索。本文对设计做比较，没有运行这些系统的横向性能实验。链接指向当时读取的公开来源，项目后续版本可能改变行为。

## 已有能力与本项目定位

### AI Scientist-v2

[官方仓库](https://github.com/SakanaAI/AI-Scientist-v2)提供从研究主题、想法到实验和论文的系统；其运行环境包含 Python、模型接口及计算依赖。[论文 §3](https://arxiv.org/html/2504.08066v1#S3)描述实验管理、树搜索、阶段检查点和视觉反馈。它已有反馈、审阅相关能力与状态记录，不能被简化为单一训练循环。

本项目把研究问题、用户约束、独立分析的材料边界，以及审阅到实施的责任关系写成 Codex 可执行的协作规程。比较的是交付形态与关注点，不宣称对方无法实现这些机制。

### Agent Laboratory

[官方仓库](https://github.com/SamuelSchmidgall/AgentLaboratory)覆盖文献、计划、实验与报告，已有 autonomous 和 co-pilot 模式及状态恢复。[原始论文 §3.3.1](https://arxiv.org/pdf/2501.04227)说明人工反馈可使子任务重做；官方实现中的 [`human_in_loop` 与 `save_state`](https://github.com/SamuelSchmidgall/AgentLaboratory/blob/main/ai_lab_repo.py)分别承接人工意见和保存工作流。

本项目不将人工介入或保存状态当作新发明。它突出用户约束与可修订主张的分层、独立判断前的输入隔离，以及每项反馈的处理依据。

### AI-Researcher

[官方仓库](https://github.com/HKUDS/AI-Researcher)提供从文献和想法到实现、验证与论文的多代理工作流。[论文 §3.2.1](https://arxiv.org/html/2505.18705v1#S3.SS2.SSS1)描述理论和实现对应检查及反馈；[`flowcache.py`](https://github.com/HKUDS/AI-Researcher/blob/main/research_agent/inno/workflow/flowcache.py)保存消息和上下文。因此不能说该系统没有评审或持久状态。

本项目直接接入 Codex 工作区及其工具，以可配置的协作协议支持不同证据方式。它没有复现 AI-Researcher 的完整执行后端，双方不能仅凭功能表比较能力强弱。

### karpathy/autoresearch

[官方 README](https://github.com/karpathy/autoresearch/blob/master/README.md)将小型语言模型训练交给 agent 自主迭代；[`program.md`](https://github.com/karpathy/autoresearch/blob/master/program.md)规定可改文件、固定训练时间、评价指标和保留或丢弃改动的循环。其 README 已明确可使用 Codex，并将 Markdown 视为研究组织的指导方式。

本项目不把“用 Markdown 指导 agent”或“可以使用 Codex”当作首创。它把开放科研中的问题分解、创新论证、条件性主张与反例纳入持续研究；推进可以不依赖单一训练指标。

### uditgoenka/autoresearch

[官方 README](https://github.com/uditgoenka/autoresearch/blob/master/README.md)已提供 Codex 支持。[orchestrator 指南](https://github.com/uditgoenka/autoresearch/blob/master/guide/autoresearch-orchestrator.md)区分基于机械成功判据的循环与探索、文档、设计决策等单次分派；也描述预算上限、状态合并、检查点及高影响改动后的验证。

本项目的区别是将开放科学问题本身纳入多轮推进：维护问题与约束、条件性主张、独立评判、反馈处理和证据范围。没有可执行成功判据时，仍可通过证明、反例或资料辨析推进约定的研究交付。两者存在重叠，不能声称只有本项目有有界执行、验证或恢复能力。

## 可以主张与不能主张什么

**当前可以主张：** 本项目为 Codex 编写了一套围绕关键科学问题、研究主线与用户需求的协作工作流；具体机制、模板、权限边界和证据记录均可在仓库中检查。

**当前不能主张：** 首个或唯一的 Codex 科研工具；首次使用多智能体、人类反馈、审稿或持久记忆；已经优于上述系统；保证无人值守产出有价值的研究。

若某种机制未在本次来源中明确描述，只能记录该材料未提供说明，不能推断整个项目不存在它。新增比较应给出直接来源，区分论文描述、当前默认实现与本地实测结果。
