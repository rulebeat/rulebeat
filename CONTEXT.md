# RuleBeat

RuleBeat is a self-hosted Azure governance tool that runs rules on a schedule and tracks every
finding until it is fixed. This glossary fixes the words used for its concepts.

## Demo

**Demo**:
A RuleBeat instance running on generated data instead of a real tenant. It is writable and shared
by everyone who opens it, returns to its starting state on every Reset, and never reaches Azure,
never runs the scheduler and never sends a notification.
_Avoid_: demo mode, demo profile, read-only demo, sandbox

**Visitor**:
Anyone using a Demo. Every Visitor is signed in automatically as the same admin and sees the
changes other Visitors make.
_Avoid_: guest, demo user

**Recording presentation**:
A Demo shown for screen recordings and screenshots: the banner is hidden and the Reset timer is off. It changes
how the Demo looks and when it resets, never what it can do.
_Avoid_: recording profile, recording mode

**Data set**:
A named, shipped description of a fake estate and its history that a Demo is generated from.
_Avoid_: fixture, scenario, sample data

**Seed**:
The number that, together with a Data set and a release, makes a generated Demo identical every
time.

**Reset**:
Returning a Demo to exactly the state it was generated in, with its dates shifted so history ends
at the moment of the Reset. Runs on a timer, or on demand.
_Avoid_: wipe, reseed, regenerate

**Locked surface**:
A part of the console a Visitor can see but not change in a Demo: the Azure connection, sign-in
configuration and user management.
