---
title: "What this is"
summary: "A signed record of how a piece of writing was written."
group: "Start here"
weight: 1
---

You are a human, and you want to write something: an email, a reply to a chat, or maybe an essay. As of June 2026, the chances of your audience assuming that you did not write it (you asked an LLM to write it for you instead) are quite high — particularly if you dare to use an em-dash. And you will find that quite annoying.

And, disturbingly, there is probably nothing you can do to actually prove that it was you who wrote it. I cannot think of anything that will not be possible to spoof by a sufficiently determined LLM.

We can, however, help you plant a stake in the ground and _claim_ authorship, and we can do it in a way that would be slow and cumbersome for a spoofer to fake. We do not prove that you wrote it. Sharing a record is your way of saying: here is the process I am willing to show.

## What we do

This is what `possiblymadebyahuman` does, by recording your writing signature: the delay between edits, the backtracking, the long pause where you got up for coffee.

We then sign the pattern of your writing with a hash chain into a short URL anyone can open. Only the shape leaves your machine; the words stay with you. You can also bind the finished text to the record, by computing a content-blind commitment on your own machine, retaining the commitment and discarding the inspected text, so a reader can confirm that the copy in front of them is the one you signed.

## What a reader sees

The statistics of the writing process and a unique signature. The reader can then check if the text they received actually matches the signature of your text. Crucially, this is all done without actually storing your text.

## How you would fake it

A script can make up an event log, including its claimed edit times, almost instantly. Server timestamps add a constraint: reproducing a twenty-minute span between the first and last checkpoints takes twenty patient minutes between submissions; reproducing a week-long span takes a week.

That is elapsed time, not writing effort. A script can prepare the events beforehand and wait between submissions. A record without server checkpoints has no such wall-clock constraint. Cheating stays possible, but a long server-observed span cannot be created in a single burst after the fact.

So it is not that hard. It's just annoying and sad enough that we hope that actual humans generally won't cheat.

---
An earlier version was partially written by a human: [historical writing record](https://possiblymadebyahuman.com/8MxUYwiQ3q). That record binds the [original Markdown source, including its front matter](https://raw.githubusercontent.com/juanre/possiblymadebyahuman/416690f934205fc5d1faeb737d8bc046545d998f/apps/site/content/docs/what-pmbah-does.md), not this revised page. To check it, paste that source into the record's document checker; the later record-link footnote is reported as extra trailing text. This historical record has no server-observed checkpoints.
