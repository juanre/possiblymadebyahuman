---
title: "Why we did not build a detector"
date: 2026-05-28
summary: "The shortest version of the design rationale: detectors quietly fail in the worst possible direction."
---

The most-asked question about `possiblymadebyahuman` is some version of:

> Will you tell me whether this was written by an AI?

The answer is no, and the reason is short.

A detector that returns "human" or "AI" — or a confidence percentage — is asked, in practice, to be right when someone's reputation, grade, livelihood, or contract depends on the answer. Current AI-text detectors are not reliable in that regime. Worse, they fail in a way that mostly hurts people who already get the short end of the stick: non-native writers, people whose writing is plain, people who do not show "interesting" stylometric variation.

We did not want to ship a system that, in its worst case, makes a reader more confident in a wrong accusation.

So we built something else: a *content-blind record of the editing process*. It does not return a verdict. It shows the shape of the work. A reader can look at it and form their own judgement, with the standing disclaimer in mind, and we deliberately do not turn that into a score.

The thing the system does well is the thing it was scoped to do: make pasted blocks visible, make atomic inserts visible, make completely empty editing processes visible. The thing it does not do — and is not asked to do — is tell you who, or what, wrote the words.
