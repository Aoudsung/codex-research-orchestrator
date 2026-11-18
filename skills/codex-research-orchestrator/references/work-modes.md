# 协作运行协议

主控先明确交付物、独立判断所需材料、执行顺序与可观察的成功条件。单人能完成的工作沿用普通任务。多人任务由主控先为各步骤调用 `bridge_plan_dispatch`，用其 `planId` 建立协议 2 子任务并绑定执行会话。项目的 `.agent-bridge/collaborators.json` 决定获准模型和通道。主控将用户指定的方法原样写到 `workMode`。默认传 `auto` 并提供结构化计划，让运行时依据步骤依赖与职责选择方式。

## 建立与运行

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
