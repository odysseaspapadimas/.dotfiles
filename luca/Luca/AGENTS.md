# Luca workspace

`~/Luca` contains separate Git repositories. Follow every touched repository's `AGENTS.md`. For requested isolated or parallel ticket work, reuse the canonical Luca Herdr hub and one ticket workspace/Pi owner, following `~/Luca/.agents/skills/luca-ticket/SKILL.md` (read it explicitly if Pi started inside a repo and did not discover the root skill). New multi-repo coordinators start at the common ticket directory, not one repo; no per-repo shell tabs or environment provisioning by default.

The hub launches independent persistent ticket sessions and hands control back; supervision, review, and independent verification require explicit requests. Fresh hub/ticket Pi sessions default to xhigh; resumed sessions keep their settings unless asked otherwise. Follow the skill's explicit launch arguments rather than silently lowering thinking or choosing a cheaper model.

Keep unrelated work intact. Before database-writing tests or migrations, ensure the target is a disposable local/test database; don't expose secrets or real patient data. Production changes and destructive cleanup need explicit authorization. Investigation and exploration do not implicitly require a PR.
