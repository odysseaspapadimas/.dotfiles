# Luca workspace

`~/Luca` contains separate Git repositories. Follow the touched repository's `AGENTS.md`. For requested parallel ticket work, use `~/Luca/.agents/skills/luca-ticket/SKILL.md` (read it explicitly if Pi started inside a repo and did not discover the root skill).

Keep unrelated work intact. Before database-writing tests or migrations, ensure the target is a disposable local/test database; don't expose secrets or real patient data. Production changes and destructive cleanup need explicit authorization. Investigation and exploration do not implicitly require a PR.
