# Eporner Browser Companion

A lightweight browser userscript for filtering 4K+ candidate videos and detecting AV1 format availability on Eporner.

## Language

### Core Filtering

**Hard Filter (4K+ Filter)**:
The irreversible removal from the DOM of video cards whose advertised resolution is strictly below 2160p (4K).
_Avoid_: Soft delete, hide, mute

**Soft Filter (Only-AV1 View)**:
The reversible temporary hiding (via display toggling) of 4K+ video cards confirmed to lack an AV1 rendition.
_Avoid_: Hard filter, permanent delete, DOM removal

**Candidate Video**:
An Eporner video card that has passed the 4K+ Hard Filter and is eligible for AV1 format probing.
_Avoid_: Download job, target, item

**Optimistic Visibility**:
The display policy where non-conclusive cards (`pending`, `probing`, `unknown`, `error`) remain visible in Only-AV1 View until confirmed as `no_av1`.
_Avoid_: Strict filtering, speculative hiding

### Format Detection & Lifecycle

**AV1 Rendition**:
A video stream encoded in AV1 format available for a given video on Eporner.
_Avoid_: Video quality, download format

**Rendition Profile**:
The structured detection result for a candidate video, containing maximum advertised resolution, AV1 available resolutions, highest AV1 resolution, 4K AV1 existence flag, and probe status.
_Avoid_: Video info, format metadata

**Probe Status**:
The lifecycle state of AV1 detection for a candidate card: `pending`, `probing`, `detected`, `no_av1`, `unknown`, or `error`.
_Avoid_: Progress, load state

**Format Badge**:
The visual in-card status indicator displaying resolution and AV1 availability (e.g., `4K · AV1 4K`, `4K · AV1 1080p`, `4K · NO AV1`, `4K · ?`), which can be clicked to manually retry when in an error state.
_Avoid_: Tag, label, chip

**Floating Toolbar**:
The simple, fixed-position screen overlay containing the Hard Filter toggle, Soft Filter toggle, and compact status counters.
_Avoid_: Modal, sidebar, floating dock

## Media Library

### Library Ready

A media item state meaning the item has enough confirmed identity and local-media linkage to appear in the normal library/menu. Optional enrichment such as performer birth date, age, director, or shoot date does not block Library Ready.
_Avoid_: Fully enriched, Metadata complete

### Release-Age

A derived display/filter value calculated from a performer's supported birth date and a work's supported release/published date.
_Avoid_: Shoot age, Performer age

### Shoot-Age

A derived display value calculated only when both performer birth date and an explicitly supported shoot date are available.
_Avoid_: Release age, Estimated age

### Unknown Age

The state used when the facts needed to calculate Release-Age or Shoot-Age are unavailable or semantically unclear. Unknown age does not block Library Ready.
_Avoid_: Missing metadata failure

### Performer Region

A browse classification derived from a performer's supported nationality/region metadata. The first library menu groups performers into Asian or Western regions; a work with performers from multiple regions appears in each applicable region view without duplicating the underlying work or file.
_Avoid_: Source region, Studio region

### Unclassified Region

A temporary browse state used when a performer's nationality/region is unknown. Missing region metadata does not block Library Ready.
_Avoid_: Invalid performer, Pending work

### Performer

A stable identity for a real person. Stage names, romanizations, localized names, and other aliases are names of the same Performer unless evidence supports separate people.
_Avoid_: Performer name as identity, Alias as separate person

### Work

A stable identity for a published content item. A JAV title, a Western scene released as a standalone item, or a separately released compilation can each be a Work. A compilation may relate back to earlier Works or Segments without becoming merely an edition of them.
_Avoid_: Filename, Provider page, Catalog number as the Work identity

### Work Identifier

An official or provider-issued identifier used to identify a Work, such as a JAV catalog number or a stable provider scene ID. One Work may have multiple parallel official identifiers; they are not inherently primary/subordinate.
_Avoid_: Internal immutable identity, Parenthetical master/alias hierarchy

### Identification Evidence

The combination of descriptive facts used to determine which Work a media item belongs to. For JAV this can include catalog number plus Performer; for Western material it can include provider, Performer, title, and provider identifiers. These facts support matching but are not themselves the Work's immutable identity.
_Avoid_: Composite database key, Metadata field values as permanent identity

### Content Version

A materially different presentation of the same Work, such as a cut/uncut or meaningfully different-duration release. Pure technical changes such as codec, container, or resolution do not create a new Content Version.
_Avoid_: Every encode as a version

### Preferred Library Version

The single version of a Work intended to remain in the final library after comparison. Other versions may be kept temporarily for review, then retained, replaced, or deleted according to the user's decision and storage constraints.
_Avoid_: Every discovered version as permanent library content

### Segment

A retained, independently indexable portion of a Work, such as A/B/C, P1/P2, or a performer-specific cut. A full Work does not require a synthetic whole-work Segment. Small timing adjustments do not create a new Segment when the intended content remains the same.
_Avoid_: Time range alone, Every file as a segment

### Local File

A concrete local media representation of a Work or Segment. Renaming or moving the same file does not create a new Local File identity; re-encoding creates a new Local File that may still represent the same Work or Segment. Exact duplicate copies are redundant rather than distinct library content.
_Avoid_: Path as identity, Codec as content identity

### Source Reference

A provider page or external metadata record used to describe a Work. Multiple Source References may describe the same Work; an additional source does not create an additional Work.
_Avoid_: Source page as Work identity
