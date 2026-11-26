# 协作运行协议

## 从题面启动

单人能完成的有界任务沿用普通任务。一次难题的候选构造、独立挑战和返修用 Boost。能同时推进并独立交付的分支用 Swarm。需要管理上游版本、依赖和终验的获准项目用 Teamwork。显式名称优先。用户消息开头的 `/teamwork` 或客户端传入的 `[/teamwork](slashCommand;teamwork)`（括号可能转义）选择外层 Teamwork。题面中要求“用 /boost 驱动各个子代理”适用于每个实质任务，不会替换外层模式。保留整个原始题面，再把组合方式及适用范围写入实施计划。

1. 从绑定到当前宿主会话的 Lead 连接调用 `bridge_collaborate`，传 `action: "open"`、`eventId`、用户题面原文 `objective`、`mode`（显式方式或 `auto`）及授权的项目范围。返回 `taskId` 和计划状态。读 `planningBrief`、项目记录和原始证据，编写 `specification`，通过 `action: "plan"` 携带 `taskId` 和 `eventId` 保存。可单独用不带 `taskId` 的 `plan` 预览。只有影响科学含义、授权或资源边界的未决事项需要问用户。
2. Teamwork 在派工前用 `action: "approve"` 记录 `approval`。`type: "existing_authorization"` 引用确实覆盖当前范围的原始请求（`task:<根任务ID>:original-request`）或已获准的合同来源，`type: "confirmed"` 引用用户确认。写明 `sourceRefs`、`successCriteria`、`constraints` 及所需的 `attachmentRefs`。这些字段接受字符串数组。待批准的新增范围维持待决。
3. 对待派的每个成员，先用具体工作目标、读写范围和隔离要求调用 `bridge_plan_dispatch`，取其 `planId` 创建协议 2 子任务。真实工作会话通过 `bridge_claim_task(taskId: ..., collaborationTaskId: ...)` 认领子任务，后者填写根任务 ID。用 `bridge_collaborate` 的 `action: "start"` 提交根 `taskId`、`eventId` 和 `bindings: {成员ID: {taskId: "对应子任务ID"}}`。按返回的就绪状态和资源上限派工。可先启动已就绪的工作，随后用 `action: "bind"` 和 `taskId`、`eventId`、`runVersion`、`memberId`、`memberTaskId` 补充真实绑定。
4. 在已有运行上用 `action: "status"` 检查进展或用 `action: "resume"` 续接，都传原 `taskId`。根据当前版本、就绪步骤和 `nextAction` 推进具体动作。执行者用真实绑定的会话，调用 `action: "brief"`，传 `taskId` 和获分配的 `stepId`。它只读取获准输入、引用和看板视图，提交版本化工作回执后退出。主控恢复时继续派发已就绪工作，并处理返修与验收。
5. 用 `bridge_work_board` 的 `status` 和 `read` 获取运行与消息，从实际读到的最后序号开始读增量。用 `post` 发布证据引用或交接，仅用 `toMemberIds` 唤醒下一位行动者。生命周期操作需要当前运行版本和事件标识。按消息实际消费进展，区分等待执行、等待证据、待主控决策和路由故障。

项目允许自动唤醒时，可在 `open`、已绑定宿主会话的 `bridge_claim_task` 或经验证后补绑定的 `bind` 中传 `autoWakeup: true`。已明确获准的传输可用 `wakeupDriver` 指定。路由使用真实会话，保留原有配置；无可用传输时保留收件箱消息。`resume` 的 `readySteps[].handoff` 给出步骤版本和投递状态。`queued`、`dispatching` 和 `host_accepted` 记录传输进展，`consumed` 表示成员读过通知，`working` 来自该版本的工作回执。看到 `resume_bound_workers`，或宿主确认成员已空闲且当前版本还有工作，主控应使用派工时记录的真实代理标识发起原生 follow-up，带上 `taskId`、`runId`、`stepId` 和 `stepVersion`，让同一成员读取返修证据并完成回执。原生宿主要求恢复该会话时，使用获准的恢复入口。原会话不可恢复时，通过已授权的成员重绑或转派安排具备相同权限的真实会话。用户无需转发任务。暂停期间等候解除暂停。

### 编写执行计划

`specification` 描述真实工作切分。Swarm 用 `tracks`；Teamwork 用 `milestones`；选填 `integration` 表示整合交付。每个条目有 `id`、`title`、`objective`、`deliverable`、字符串 `acceptance`、可选的 `writeRoots` 和 `dependsOn`。顶层 `requirements` 用 `{id, description}` 把每项用户要求写成终验依据，`maxParallel` 记录获准的并发上限。Teamwork 里程碑可以标为 `mode: "boost"` 或 `mode: "swarm"`，后者可有各自的 `tracks`。当用户要求每个实质任务都用 Boost 时，传 `strategy: {boostScope: "substantive_tracks"}`，并在简报中明确应挑战的候选和验收的证据。显式大团队在同一个 `strategy` 里写 `teamSize: "large"`。查阅工具 schema 选取与实际交付匹配的 `route`。

若当前会话没有 Lead 工具、身份显示为别的客户端或缺少真实宿主会话绑定，检查项目内的 Lead 配置和正常会话启动方式。安装版从工作区运行 `python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py doctor --project . --client codex`；执行获准的 `connect` 和宿主重新加载，再检查实际身份和路由。会话 ID 来自宿主或执行器。普通模式可继续做本地有权处理的工作，显式多人模式需要如实说明剩余绑定或权限缺口。

当前 Codex 会话已提供 `CODEX_THREAD_ID`、旧全局 MCP 配置仍绑定了错误调用者时，可从实际宿主回合用项目 CLI 调用同一组 MCP 工具。先运行下列命令查看可用动作，再用 `open` 接收标准输入里的原始请求，或用 `resume <taskId>` 恢复。

```sh
python3 .agents/skills/codex-research-orchestrator/scripts/research_setup.py collaborate --project . -- --help
```

全局挂载可使用该技能目录下的同一个 `scripts/research_setup.py` 并指定真实项目。Lead、子任务和续接共用同一项目库。自定义项目数据库用 `--bridge-db` 显式指定，并在各会话沿用。Worker 用宿主配置的 `worker` profile，或在启动 CLI 时补充 `--worker`，然后执行 `claim`、`brief` 或提交回执。

## 大团队与逐任务 Boost

大团队可以是分环境的研究、多组件工程或显式大规模证明。按真实独立性设置赛道、接口责任人和独立验收者，按获准并发和预算分批启动。每个要求使用 Boost 的实质任务都需要一份版本化候选、一位独立会话的改进或挑战者、基于反例的修复与复测，以及项目级的独立验收。将没有发现反例的观察也附在候选版本上。验收者检查证据和跨分支的一致性。把这一要求写进新增成员、接手者及其分支的简报。基础复核、消息中转和重复读取直接完成。

跨环境、跨模型规模比较先建“规模 × 环境”证据矩阵，列出用户要求覆盖的每个条件。每个格子核对同规模基线、训练数据及分割、信息与工具权限、交互及训练推理预算、调参机会、随机种子、评估版本、指标和聚合规则。修改实现时保留原评估语义。有限格子只支持已测条件。声称适用于所有规模需要另外的论证。缺少可比证据的格子进入开放问题。已有权限下推进资料复核、实现和获准实验。

公平比较时，主控把对比方案写到 `specification.comparisonProtocol`，用 `purpose: "design"` 或 `"measurement"` 指定方案或实测交付，用 `dimensions` 枚举轴和值，用 `matchFields` 冻结逐格匹配的条件，可用 `openDimensions` 标记存在未覆盖值的轴。最终审计人在工作回执中提交 `comparisonEvidence`。覆盖范围用 `scope: "listed"`。每格按候选和基线分别记录 `settings` 与 `evidenceRefs`。实测记录还须有有限数值 `value`、独立的 `resultRef` 与双方一致的 `metric: {name, direction, unit}`（方向为 `higher` 或 `lower`）。附加比较结论须引用双方实际结果。部分交付用 `unmatched`、`unmeasured` 和 `reason` 说明缺口。所有结果引用都要回到最终步骤的原始证据。

## 低层工作运行协议

既有任务可沿用根任务和子任务的协议，通过下列参数查看或续接。新建 Boost、Swarm 或 Teamwork 优先使用 Lead 入口。

从宿主已经绑定会话的 lead 连接调用 `bridge_create_task`。根任务的 `taskId` 就是 `runId`。成员拥有各自的子任务与真实会话 ID。先准备各子任务及符合授权的唤醒路由，再建根任务。主控保留开新任务、调度和验收职责。在按会话绑定的单独 MCP 进程中，由宿主提供 `BRIDGE_CALLER_SESSION_ID`；Codex 也可使用其实际的 `CODEX_THREAD_ID`。不要把会话标识作为用户消息中的身份证明。

下面是公开调查的计划片段。示例中的子任务 ID 和会话 ID 须替换为本次真实绑定。

```json
{
  "workMode": "auto",
  "workPlan": {
    "members": [
      {"memberId":"author","agent":"codex","taskId":"author-task","conversationId":"author-session"},
      {"memberId":"reviewer","agent":"codex","taskId":"review-task","conversationId":"review-session"}
    ],
    "steps": [
      {"stepId":"explain","memberId":"author","kind":"work"},
      {"stepId":"challenge","memberId":"reviewer","kind":"challenge","dependsOn":["explain"]}
    ],
    "requirements": [
      {"requirementId":"cause","description":"复现现象并区分竞争解释","stepIds":["explain","challenge"]}
    ]
  }
}
```

拆分并行工作时，把独立修改分给不同作者，在整合步骤用 `dependsOn` 引用各分支。公开求证用 `challenge`，把反例连到被审查的版本。严格独立判断用至少两个只读 `independent` 根步骤，分别绑定不同成员；给每位成员提供 `inputPacket.entries`，其中至少各有一项 `definition`、`evidence`，每项有 `ref` 与已经批准的内联 `content`。创建依赖全部独立步骤的 `synthesis` 或 `review`。当前独立执行入口为受控的显式 PI 任务。只发冻结文本，执行器使用无工具的新会话，验证后封存交付。原生工作区执行者可做公开复核。跨阶段工作用 `milestone` 步骤记录预期依赖。查看 `bridge_get_task_overview` 返回的 `workRun.readySteps` 确认谁可以开工。

通过 `bridge_send_message(taskId,runId,toMemberId,eventId,content)` 发送定向交接。重发同一事件应使用同一键和内容。收件人用 `bridge_read_messages(runId,unreadOnly=true)` 读取，同一模型的不同会话分别寻址。发件人用 `bridge_read_messages(receiptForMessageId)` 查看消费回执。暂时没有路由时，消息保留在成员收件箱。

执行者用 `bridge_submit_task_receipt(operation="work_step",taskId,runId,stepId,stepVersion,receiptId,outcome,summary,evidenceRefs)` 报告结果。有效反例使用 `outcome="counterexample"` 和 `counterexample={stepId,description,evidenceRefs}` 指定需要修正的上游结果。主控用 `outcome="revise"` 附修订理由和 `sourceRefs`。读取新版本，按就绪状态重新分工。独立步骤的交付由受控执行器证明。最终由接收者调用 `bridge_accept_task_delivery(taskId,runId,eventId,runVersion,requirementEvidence)`；每项引用要求编号、步骤、版本、原始回执及其证据。对照合同判断这些证据究竟支持哪项科学结论。

每项验收意见可附 `assessment` 和 `explanation`。完成交付要求当前证据支持所有必要项。出现反例或依据不足且授权范围或预算已尽时，接收者用 `disposition="partial"`、`summary`、`openQuestions` 明确结案。对尚无证据的要求标记 `insufficient` 并写明缺失信息。部分结案停止待派工作，保留已获得的回执。

## 关键断言的独立验真

整合稿交付后，主控将其版本摘要、用户题面与获准的冻结工作区交给一个新会话。验证者从稿中选择决定交付结论的断言，在执行前记录原文、适用条件和可判定的预期。优先通过公开入口与最小合成夹具重放。主控保持正常沙箱和任务的读写授权，只为验真提供所需的运行入口。先前答案、盲评标准与生产数据不进入验证会话。

把命令、输入、实际输出、退出状态和被测稿件版本放进可追踪的证据。测试通过记录须指出对应断言和实际观测。结果与预期不符时，按观察修正或限定断言，保留差异和适用范围。验收核对最终稿引用的证据与具体断言。稿件改变了断言或其适用条件时，复核证据能否覆盖变动，必要时用新版本重放。

如果独立分支的材料可直接整合，作者用轻量并行收集结果，在草稿中把每条影响结论的主要断言单列成有出处的完整句。验证者只复现会改变交付判断的断言。若证据允许局部更正，验证者提交冻结稿中唯一对应的原句和可直接置换的文本，并检查报告其他段落与勘误是否一致。主控依据既有写入授权提交并应用这份有来源记录的更正。正式验收核对实际终稿与按原稿、勘误和证据生成的候选逐字一致。结论均获支持时，记录针对原句的实际观测。无法定位原句或局部更正会留下冲突时，保留草稿与实测证据，按部分交付记录缺口。

## 限时调查的首次交付与复核

比较两个限时运行时，冻结题面、实现起点、模型、权限和总墙钟预算。首次可能调用模型前开始计时，并为派工、首份可应用修改、独立复核、返修和验收分别保留起止记录。遇到超时，先读取调度和提供方事件，区分已完成的工具耗时、已报告的模型耗时，以及最后一次可见事件到停止之间的间隔。无法拆分的时间标为未归因。

记录首份可应用候选的交付时间与关联版本。若到截止时间仍没有候选，记录作者用时、最后一个可见事件及尚未启动的复核阶段，并按部分交付结案。下一轮依据这份记录选择要改变的环节。
