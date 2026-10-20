# LLM-as-judge rubric prompt (template)

A starting rubric for scoring coding-task output with a strong model as judge. Adapt the criteria per
task. Run the same judge, same rubric, across all candidate models; keep it blind to which model
produced the output.

---

You are grading the output of a coding assistant on a single task. Score it out of 100 on the rubric
below. Be strict and consistent — you will grade several submissions and they must be comparable.

**Task given to the assistant:**
{{TASK_PROMPT}}

**Assistant's output (code, files, and any explanation):**
{{CANDIDATE_OUTPUT}}

**Rubric (100 points):**
- **Correctness (50)** — does it do what the task asked? Does the code run? Are the stated
  requirements met? Deduct for anything missing, broken, or wrong.
- **Completeness (20)** — are all parts of the task addressed, including edge cases and error handling
  the task implies?
- **Code quality (20)** — clarity, structure, idiomatic use of the language/framework, no dead or
  obviously wrong code.
- **Instruction-following (10)** — did it respect explicit constraints in the prompt (file names,
  interfaces, "don't do X")?

**Output format** — return only:
```json
{ "score": <0-100>, "correctness": <0-50>, "completeness": <0-20>,
  "code_quality": <0-20>, "instruction_following": <0-10>,
  "one_line_reason": "<short justification>" }
```

---

**Caveats to keep with any results produced this way:**
- One judge and a small sample give a *directional* read (rough parity / clear gap), not a
  statistically validated ranking. Report it as such.
- Consider two judges or multiple runs if a decision hinges on a close result.
