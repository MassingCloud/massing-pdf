# Accessibility

A review tool produces contract documents. Being unable to use it without a mouse or without sight
excludes someone from the record, not merely from a convenience — and WCAG 2.1 AA conformance is
usually also a procurement condition for public-sector and large-enterprise buyers.

This page states what conforms, what does not, and what is untested, so a buyer's accessibility
review has something honest to work from rather than a claim.

## Summary

| | |
|---|---|
| Target | WCAG 2.1 Level AA |
| Status | **Conformant, unaudited.** Every panel, list and control is keyboard-operable and labelled, and the drawing canvas can be traversed and drawn on with a keyboard. No third party has checked this, and no screen-reader testing has been done — see *Not verified*. |
| Verified by | `e2e/a11y.spec.ts` and `e2e/conflict.spec.ts` drive real keys against the real DOM; `e2e/a11y-tree.spec.ts` asserts against the computed accessibility tree. Every CI build. |
| Not verified | Screen-reader output on JAWS, NVDA or VoiceOver; magnification beyond 200%; a formal third-party audit |

Two different things are tested, and the difference matters.

The key-driving tests prove the **mechanics**: focus moves, Enter acts, the right thing happened.
The tree tests prove the **naming**: they read the computed accessibility tree — the same role-and-
name pairs an assistive technology consumes — and fail when a control reaches it unnamed, or named
only by a glyph, or when a set of rows all announce identically.

That second kind catches what the first cannot, and it is not hypothetical. Introducing it found
five controls that were fully operable by keyboard and effectively anonymous to a screen reader: the
page-number field announcing as "spin button, 1", three unnamed `combobox`es, and a sort button
whose entire accessible name was "↓". Every key-driven test passed on all of them, because pressing
them worked. What was wrong was what they would be *called*.

**Neither is a screen reader.** They prove a name exists and is distinct; they cannot tell you it is
*useful*, that the reading order makes sense, or that a live-region announcement lands at a moment
that helps. Treat the untested row as genuinely untested, not as a formality.

## What works

**Keyboard.** Every list — markups, sheets, pins, search results, spec references, saved views — is
a single tab stop with arrow-key navigation inside it (`Home` and `End` jump to the ends). Enter and
Space activate. `Space` is prevented from its default page-scroll, which in a viewer would drag the
drawing out from under the keypress. Toolbar buttons are real `<button>` elements with single-key
shortcuts.

**Names and roles.** The shell exposes landmarks (toolbar, drawing region, side panels, status).
Tool buttons carry `aria-label` with the tool name and shortcut, because the visible label is a
single glyph that reads as an emoji name or as nothing. Markup rows are `role="option"` inside a
`role="listbox"`, labelled with kind, page, status, subject and author.

**State, not just colour.** A markup's status is conveyed visually by a coloured swatch; the same
information is in the row's accessible name. An armed tool sets `aria-pressed`, a selected row sets
`aria-selected`. This is WCAG 1.4.1 (Use of Colour), and it is the failure most easily missed.

**Announcements.** Page changes, tool changes, save failures and load results go to a live region —
`polite` for status, `assertive` for errors. `viewer.announce()` is public so a host replacing the
toolbar can still be heard.

**Focus visibility.** A focus ring appears for keyboard use and not for mouse clicks. Styling
`:focus` and then removing the ring because it looked wrong on click is the usual route to an
unusable interface; this avoids the trade.

`:focus-visible` alone is not enough. Arrow-key navigation moves focus with a programmatic
`focus()`, and engines disagree about whether that counts as keyboard-initiated — Firefox does not
match, which left someone arrowing through a list with no visible focus at all. Arrow navigation
therefore sets an explicit `data-kbd-focus` attribute, which behaves identically everywhere, and the
ring is styled off both.

**The canvas, not just the panels.** With the drawing focused:

| | |
|---|---|
| `Alt` + arrow | step the selection through the markups on the sheet, in reading order, announcing where you are ("3 of 11") |
| arrow | nudge the selected markups — 1pt, or 10pt with `Shift` |
| arrow, with a tool armed | aim the drawing cursor — 4pt, or 24pt with `Shift` |
| `Space` | place a point where you are aiming |
| `Enter` | finish the markup |
| `Escape` | abandon it |
| arrow, with nothing to move | pan the sheet |

`Space` and `Enter` are deliberately different keys. With one doing both there is no way to say
"another vertex" rather than "done", which makes a polygon impossible without a pointer. Arming a
tool announces the keys, because a keyboard route nobody is told about is one nobody uses.

Arrows only get claimed when there is something for them to do, so they remain the way to pan.
While a tool is armed the aim is drawn on the sheet — a pointer brings its own cursor, and without
one the person aiming would be the only one who cannot see where.

**The one modal.** `conflictsPlugin`'s dialog is `role="dialog"` with `aria-modal="true"`, traps Tab
inside itself, returns focus to whatever had it on close, and answers Escape. It also opens focused
on **"Keep theirs"** — the choice that discards nothing — so pressing Enter on a dialog you have not
read cannot be how a colleague's edit gets overwritten. That is a keyboard-safety decision as much
as an accessibility one: the fastest path through a modal should never be the destructive one.

**Reduced motion and forced colours.** `prefers-reduced-motion` suppresses transitions —
vestibular disorders make a panning, zooming viewer a worst case. Windows High Contrast Mode
(`forced-colors`) restores borders for states that would otherwise be conveyed by a background
colour the mode replaces.

## What does not work

**Spatial judgement still needs sight.** You can now author and traverse on the canvas with a
keyboard (see below), but placing a markup *accurately over the right piece of linework* is a visual
task, and nothing here changes that. Aiming by arrow key is workable for a cloud around a region; it
is not a substitute for seeing what you are enclosing.

**Spatial information is not conveyed.** "A cloud on page 2 near the north stair" is not something
the library can say; it knows page coordinates, not what is at them. A markup's *subject* is the
only description a screen-reader user gets, which puts weight on reviewers writing one.

**No formal audit or VPAT.** Nobody has tested this with a screen reader in anger. If you need a
VPAT for procurement, treat this document as input to one, not as one.

**Text in the PDF itself.** A drawing's own lettering is the publisher's content. Where the PDF has
a text layer it is selectable; a scanned sheet has none until an OCR provider is configured, and
neither case is under this library's control.

## Reporting a problem

Open an issue with the assistive technology, browser and OS, and what you expected to happen.
Accessibility bugs are treated as functional bugs, not enhancements.
