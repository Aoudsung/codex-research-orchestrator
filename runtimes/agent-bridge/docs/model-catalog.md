# Project model catalog

`bridge_plan_dispatch` uses the project’s `.agent-bridge/collaborators.json` to choose a model for a workload. A project can set `modelCatalog` by editing that file or passing the field in an update to `bridge_sync_collaborators`. The keys are executable model IDs in preference order.

```json
{
  "modelCatalog": {
    "gpt-6.2-astra": {
      "channels": ["codex"],
      "capabilities": ["blind_review", "math_or_efficiency_audit"]
    },
    "gpt-6.2-sol": {
      "channels": ["codex"],
      "capabilities": ["coupled_core_impl", "bounded_module_or_data"]
    },
    "gpt-6.1-sol": {
      "channels": ["codex"],
      "capabilities": []
    }
  }
}
```

The project catalog replaces the built-in model list. Copy each model that should remain available when adding a catalog. An empty `capabilities` array reserves a model for explicit selection. Removing the `modelCatalog` property from the file restores the built-in defaults. Projects that omit the property can keep using their existing pinned sessions, custom aliases, and legacy `explicitPiRoutes`.

Automatic selection uses the first model whose capabilities and channels match the workload, context and isolation. A capability is a workload name or an object with `workload`, optional `contextScales`, and optional `explicitChannelOnly`. Supported scale names are `small`, `medium`, and `large_repo_or_logs`. An explicit channel restricts the candidates to that authorized channel. An explicit model takes precedence over inferred capability and preference rules. Its channel must be authorized and compatible with the task’s isolation.

The built-in catalog uses GPT-6.2 Astra for independent blind review and formal audits, GPT-6.2 Sol for coupled implementation, ChatGPT Pro for macro breakthroughs, and Gemini Carbon for panoramic design and large-context audits. Lightweight monitoring and small log extraction use GPT-6 Luna at `low` through a read-only role. Gemini bindings still honor `channelPreferences.gemini` and choose a configured pinned Antigravity conversation for the same model when the preferred PI session is busy. A project can also explicitly select a model registered through `explicitPiRoutes`. Add that model to the catalog with channel `pi_task_explicit` to make it eligible for automatic selection.

Models and effort tiers are checked against the selected runtime where effort judgment applies. An explicit effort may use `ultra` when the runtime lists it. Luna judgment uses the selected model’s supported effort tiers with `ultra` excluded. A lookup, binding, or judgment failure is returned with the selected route’s error.
