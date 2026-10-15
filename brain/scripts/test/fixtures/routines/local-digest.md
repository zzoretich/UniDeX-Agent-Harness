---
schema: 1
name: Local digest
kind: prompt
schedule: "0 18 * * 1-5"
enabled: true
engine: local
model: "qwen3.5:9b"
maxTurns: 12
writes: [notes/digests/, "brain/reflections/*.md"]
output: notify
timeoutSec: 900
tags: [digest]
---
Read today's daily note and list what changed in notes/ since yesterday.
Write the digest to notes/digests/today.md, then reply with three lines.
