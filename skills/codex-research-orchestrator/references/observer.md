# Optional Observation & Process Diagnosis

Use only within explicit user authorization. Separate raw fact collection from process interpretation:

- **[Fact observer](roles/fact-observer.md):** Runs read-only incremental checks over permitted sources and returns source-backed events (distinguishing source time vs observation time and claimed vs recorded completion) or verbatim `UNCHANGED`. Never rates progress or writes recommendations.
- **[Collaboration optimizer](roles/optimizer.md):** Interprets observed evidence (without inventing missing cost numbers), identifies collaboration bottlenecks, and writes concrete process recommendations in the observation area only.

Keep one observer instance, track proposed/accepted/implemented/observed effects separately, and never let observation scripts overwrite Lead research state or block scientific decisions.
