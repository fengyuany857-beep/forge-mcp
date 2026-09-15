# ForgeMCP

ForgeMCP is a generic capability-first assembly system for building projects from verified existing implementations before writing new code.

Core doctrine:

> 默认不造轮子。先拆能力，再搜轮子，最后才写缺失部分。

Highest structural principle:

> 结构必须服从事实，不允许事实服从结构。

The generic flow is:

Goal → Requirements → Capability Graph → Discovery → Inspection → Selection → Composition → Assembly & Build → Verification → Feedback

ForgeMCP is domain-neutral. It owns generic discovery, Contract extraction, implementation selection, composition, assembly, verification and evidence/provenance patterns. It does not own image-specific retrieval, ranking, Booru/Pixiv integrations, visual similarity or image preference logic.

PicMCP is a separate consumer/case study:
https://github.com/fengyuany857-beep/pic-mcp

## Formal specification source

The current formal specification remains in Google Drive. This repository does not silently replace those Canonical documents.

Project folder:
https://drive.google.com/drive/folders/1UFz1kan4PP0ytKqqVTXX_VLoS-d-n9s1

Key documents:

- Universal Project Organ entry: https://docs.google.com/document/d/1Kj3LCIzK_ynDs9CHStka3Vf3XUfhoB74WsEAid8AqJU/edit
- Bundle Manifest: https://docs.google.com/document/d/1VMXAAk1YE5craFLKXEWaBLFb04-IPSH5jGn0_rqn3SY/edit
- Assembly & Build Engine: https://docs.google.com/document/d/1EA-LsyYZR2dXmrn0h9DsVzynwknlWgGcJYxi2RnBE4A/edit

Until a future explicitly verified governance change says otherwise, Google Drive remains the formal rule/specification source and this repository is the implementation workspace.
