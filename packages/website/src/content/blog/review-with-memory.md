---
title: "Automating reviews doesn't mean losing taste"
subtitle: "You set the standard. Automation keeps it."
description: "You can't write down your taste. But you keep working by it, and Lore learns it the way an apprentice would, then helps enforce it in code review."
pubDate: 2026-07-20
author: Burak Yigit Kaya
tags:
  - knowledge
  - code review
  - ci
  - agents
---

About ten years ago, when machine learning got good enough that you could train a real
classifier without a research lab, I had a specific daydream. I wanted to train something that
reviewed code the way I did, so I could step back from reviewing every change without the
codebase drifting and without losing the thing reviews were quietly doing for the team. I never
built it. I never had enough of the right data, and I never had the time. It stayed a daydream.

I'm bringing it up because the debate about review has finally caught up to it, and I think both
sides are half right in a way that's worth untangling.

## The same complaint from two sides

One camp says the whole point of writing code with agents is that a human still reads every line
before it ships. Slow down, look closely, stay in control. The other camp, often the same people
on a different day, says the job has quietly turned into something worse: you don't write much
anymore, you sit and read change after change the machine produced, and it is dull and a little
soul-crushing. Reviewing slop, they call it.

Those sound like opposite positions. They're the same one. Review used to be where
judgment happened and where the team learned how the codebase was meant to work. Now, for a lot
of people, it has shrunk to a checkpoint you sign off on. The "read every line" camp wants to
protect what review was. The "this is soul-crushing" camp is telling you it has already gone.
Neither wants less care in the codebase. Both are answering the same loss.

A colleague told me the human side of this a few months ago. When he joined the team, he said, he
learned a lot from getting detailed code reviews from me, the kind where you explain not just what
to change but why the team works this way. What he picked up wasn't a list of rules. It was a way
of working. These days we mostly work on our own, agents write and review most of the code, and he
told me he kind of misses that. He wasn't complaining about speed. He was noticing that something
had stopped passing between us.

## What review was really passing along

That's the part the speed argument misses. A review was never only a gate. It was how one person's
standard reached everyone else. You don't mock the database in integration tests, and here's the
migration bug that taught us why. Deploys go from the release branch, because of the time they
didn't. The standard arrived with its reason, at the moment it mattered, to whoever happened to be
on the change.

When that stops, the rules don't disappear. They just stop showing up when they're needed. Here
is the failure we kept hitting, the one that made me want to build the daydream in the first
place: six months later a pull request quietly brings back the exact thing the team decided
against. Not out of carelessness. The author wasn't in the room when the decision was made, or
was, and it was a year ago. The one reviewer who would catch it at once isn't on this PR. So it
merges, and the team learns the lesson again the expensive way.

Look closely at what kind of failure that is. Nobody used bad judgment. The change looks
reasonable on its own. What was missing wasn't a smarter reviewer. It was a reviewer who knew the
standard the team set and noticed, at that moment, that the change cut against it. That is not a
problem of judgment. It is a problem of a standard nobody applied at the right time.

## You can't write it down. You do it.

Here is the hard part, and it's why my old daydream needed data I never had. Most of what makes a
good reviewer good is not a rule you can write down. It's taste, built from years of doing the
work. Ask someone to put their standards in a document and they'll give you a thin, lifeless
version of what they actually do. You are what you do, not what you manage to write down. But you
keep doing it, review after review, decision after decision, and the standard is real even when
the document isn't.

That's the shift that makes this possible now. Lore watches the work the way an apprentice does.
It sits alongside your sessions, distills what you decide and why, and writes it down for you as
[`.lore.md`](/docs/team-memory/), a version-controlled file of the team's decisions, patterns, and
gotchas, kept in plain Markdown and reviewed in pull requests like any other file. We've written
before about [why that learning lives in text](/blog/distill-your-own-knowledge/) rather than
baked into a model: text is something you can read, diff, carry to the next model, and correct a
line at a time. You don't fill in a form. You work, and it learns.

An apprentice is not you, and I want to be honest about the ceiling. It won't learn your deepest
judgment, the calls that come from taste you couldn't explain if you tried. But it learns the
standards you set often enough to leave a mark, and that turns out to be a lot of them.

## The apprentice reviews the code

This is the narrow thing I actually wanted ten years ago, and it turns out it was the achievable
part all along. Not a bot that reproduces my judgment. Something that has learned the standards
and speaks up when a change goes against one.

So we built a check that reads the diff against what Lore has learned. On every pull request, the
[semantic linter](/docs/guides/semantic-linter/) takes the changes and the standards from
`.lore.md` and asks, for the pairs that look related, one narrow question: does this change go
against something the team decided? When it thinks the answer is yes, it says so, as an annotation
on the PR, next to the line, with the reason attached. The reason is the point. It's the part of
the review that used to pass from person to person and stopped.

It's a judge, not a rule engine, and that distinction is everything. "Never mock the database in
integration tests" isn't a pattern you can match with a regex. It's a meaning. You can only check
it by understanding what the change does and what the standard intends, which is exactly the
reading we used to need a person for. The honest cost is that a judge produces suspicions, not
verdicts. It can be wrong. We designed around that instead of pretending otherwise.

## Why it doesn't fail your build

If you're in the "read every line" camp, the thing you're rightly afraid of is a noisy automated
check that blocks work on a bad guess. We share that fear, so the linter ships advisory only. It
never fails a build. It leaves a note and a human decides. A probabilistic check that can break
CI is just a probabilistic build-breaker, and it would teach everyone to ignore it inside a week.

And if you're in the "this is soul-crushing" camp, look at what the linter takes off you. It is
not the interesting part of review. It is the dull part: checking every change against every
decision the team has made, which is the work no human does well and no human enjoys. Give that
to the machine and what's left is the judgment, the taste, whether this is even the right change.
The part that was worth doing in the first place.

Cost gets the same restraint. A large PR against a full knowledge base is thousands of change-
and-rule pairs, and calling a model on each one would be slow and expensive. Almost all of those
pairs are unrelated, so we drop them for free first with a local embedding pass, and spend a
model call only on the few that look like they might conflict. The model is the last stage of the
check, not the first.

There's a ladder above advisory, for teams that watch how often the check is wrong on their own
repo and decide a particular rule is worth blocking on, with a way for an author who knows better
to override it. But the default sits at the bottom of that ladder on purpose. The system earns
trust before it can block anything.

## The narrow claim

I'm not claiming the reviewer goes away. The judgment and taste in a review, the part the "read
every line" camp is protecting, is not what this replaces, and I'd distrust anyone selling that.
The claim is narrower and, I think, harder to argue with. No reviewer can hold every standard the
team has set and apply the right one at the right moment. That one job, a system does well, and
handing it over costs you none of the taste you were afraid to lose. It gives you back the
attention for the parts that need a person, and it brings back, a little, what used to pass
between people when they reviewed each other's work.

That's the version of automated review I'd ask a doubter to try. Not a bot that approves your PRs.
An apprentice that learned how you work and speaks up when a change breaks from that, and otherwise
stays quiet.

Because a check that reads every diff against your team's standards is a lot to take on trust, the
code that decides what it flags is open to read. Lore is [Fair Source](https://fair.io)
(FSL-1.1-Apache-2.0), and it becomes Apache 2.0 after a set time. A standard you can watch enforce
itself is worth more than one you have to hold in your head.
