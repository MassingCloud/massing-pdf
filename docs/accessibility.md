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
| Status | **Partially conformant.** Every panel, list and control is keyboard-operable and labelled. The drawing canvas itself is not directly navigable — see below. |
| Verified by | `e2e/a11y.spec.ts`, run on every CI build, driving real keys against the real DOM |
| Not verified | Screen-reader output on JAWS, NVDA or VoiceOver; magnification beyond 200%; a formal third-party audit |

Automated tests prove the mechanics — focus moves, Enter activates, names are present. They cannot
tell you whether what a screen reader says is *useful*. Treat the untested row as genuinely
untested, not as a formality.

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

**Focus visibility.** A focus ring is applied via `:focus-visible`, so it appears for keyboard use
and not for mouse clicks. Styling `:focus` and then removing the ring because it looked wrong on
click is the usual route to an unusable interface; this avoids the trade.

**Reduced motion and forced colours.** `prefers-reduced-motion` suppresses transitions —
vestibular disorders make a panning, zooming viewer a worst case. Windows High Contrast Mode
(`forced-colors`) restores borders for states that would otherwise be conveyed by a background
colour the mode replaces.

## What does not work

**The drawing canvas is not directly keyboard-navigable.** You cannot Tab between markups *on the
sheet*, or draw one with the keyboard. The markup list is the accessible equivalent: everything on
the drawing appears there, is reachable, and selecting a row moves the view to it. This is a real
limitation, not a workaround we consider equivalent — drawing a revision cloud requires a pointing
device.

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
