---
'@rivus/agent-presence': patch
---

Run source-mode queue watchdogs on Node.js 26, where the experimental type-transform flag has been removed, while retaining support for older Node runtimes that accept the flag. Use erasable fields in provider constructors so source-mode workers also load without type transformation.
