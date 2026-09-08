# DRAFT — for review, not yet agreed. Generated 2026-08-06 from apps/sparcd-tagger (src/components/SpeciesPanel.tsx, src/components/SpeciesLoupe.tsx, src/lib/drafts.ts, src/lib/keys.ts, src/lib/species.ts, src/sections/Tag.tsx).

@H2
Feature: Assign species to images in an upload

  """
  As a species identifier, I want to assign species to images in a new upload,
  so that the upload's data becomes usable for analysis.
  """

  As-built: a persistent species panel sits beside the images. A species can
  be selected by clicking its tile and applied with its add control, by
  drag-and-drop, or by pressing the key bound to it. An
  identification applies to the focused image, or to every selected image when
  a selection exists. Identifications are held locally until they are synced.

  Background:
    Given an upload is open in the tagging workspace
    And the species vocabulary has loaded

  @H2
  Scenario: The species list is browsable, not only searchable
    Then every species in the vocabulary is listed with its common and scientific name
    And each species shows its reference image where one exists
    And each species shows the key bound to it, when it has one
    And Ghost appears exactly once as a species from the vocabulary

  @H2
  Scenario: The species list is labelled "Available species" when an image is focused
    Given an image is focused
    Then the species list is headed "Available species"

  @H2
  Scenario: Clicking a species tile highlights it without identifying an image
    Given an image is focused
    When a species tile is selected
    Then that species tile remains highlighted
    And selecting the species has not changed the focused image

  @H2
  Scenario: An image can carry more than one species
    Given the focused image already carries one species
    When a second species is applied to it
    Then both species are recorded on that image
    And neither replaces the other

  @H2
  Scenario: Applying a species that is already on the image changes nothing
    Given the focused image already carries a species
    Then that species' row is marked as applied
    And using it again neither duplicates the species nor changes its count

  @H2
  Scenario: One action identifies every image in a selection
    Given several images are selected
    Then the species panel states how many images an identification will apply to
    And applying a species records it on every selected image

  @H2
  Scenario: An empty frame is labelled as such
    When the Ghost label is applied to an image
    Then the image is recorded as an empty or false-trigger frame
    And any real species previously on that image is removed
    And applying a real species afterwards removes the Ghost label

  @H2
  Scenario: The species list can be narrowed by typing
    When text is typed into the species filter
    Then the list narrows to species matching that text by common or scientific name
    And close-but-inexact spellings still match

  @H2
  Scenario: A species not in the vocabulary can still be recorded as a request
    Given filter text matches no species exactly
    Then the panel offers to record the typed name as a requested species
    And applying it records that free text against the image alongside the identification

  @H2
  Scenario: Species used recently are easier to reach
    Given several species have been applied during this session
    Then those species are listed first, most recently used first
    And their key bindings are unchanged by that reordering

  @H2
  Scenario: A species can be given a key so it can be applied by keystroke
    Given a species row is shown
    When a key is assigned to it and that key is pressed with an image focused
    Then that species is recorded on the image
    And the assigned key is shown on the species row

  @H2
  Scenario Outline: Printable bindings, including former shortcuts, take precedence
    Given an image is focused
    When "<key>" is assigned to a species and pressed
    Then that species is recorded on the image
    And the keyboard shortcut reference is not opened

    Examples:
      | key |
      | ?   |
      | !   |
      | j   |
      | k   |
      | x   |
      | 7   |

  @H2
  Scenario: Alt or Option modified keys remain available to the browser
    Given an image is focused
    When an Alt-modified printable key is pressed while assigning a species key
    Then key capture remains active and no key is assigned
    When a Shift-produced symbol is assigned to the species
    And that binding is pressed with Alt or Option
    Then the species is not recorded on the image
    When that binding is pressed without Alt or Option
    Then that species is recorded on the image

  @H2
  Scenario: Alphabetic bindings are case insensitive
    Given an image is focused
    When a lowercase alphabetic key is assigned to a species
    And the uppercase form of that binding is pressed
    Then that species is recorded on the image

  @H2
  Scenario: An unassigned printable shortcut retains its built-in behavior
    Given an image is focused
    When the unassigned keyboard-help shortcut is pressed
    Then the keyboard shortcut reference is opened

  @H2
  Scenario: Keys already bound in the desktop app work without re-assignment
    Given the species vocabulary carries a key binding for a species
    Then that key applies the species without any local assignment
    And a locally assigned key replaces it for that species

  @H2
  Scenario: Pressing a species key repeatedly increments the count each time
    Given the species vocabulary carries a key binding for a species
    And an image is focused
    When the bound key is pressed three times
    Then the species count on that image is three

  @H2
  Scenario: A species key increments every selected image from its own count
    Given the species vocabulary carries a key binding for a species
    And several images are selected
    When the bound key is pressed once
    Then each selected image increments the species from its own count

  @H2
  Scenario: Pressing the Ghost key repeatedly does not change its count
    Given an image is focused
    When the Ghost key is pressed multiple times
    Then the image still carries Ghost with a count of one

  @H2
  Scenario: A key belongs to only one species
    Given a key is already assigned to one species
    When the same key is assigned to a different species
    Then an unmistakable duplicate-key warning identifies the existing assignment
    And neither binding changes before reassignment is confirmed
    When the duplicate key reassignment is confirmed
    Then the new species takes the key
    And the previous species is left without one

  @H2
  Scenario: A duplicate vocabulary key can be kept with its existing species
    Given the species vocabulary carries a key binding for a species
    When its key is assigned to a different species
    Then an unmistakable duplicate-key warning identifies the existing assignment
    And keyboard focus remains inside the duplicate-key warning
    When the duplicate key warning is cancelled with Escape
    Then the vocabulary key remains with its original species

  @H2
  Scenario: Key assignments survive across sessions on this machine
    Given keys have been assigned locally
    When the tagger is reopened later in the same browser
    Then those key assignments are still in effect
    When the key is cleared for that species
    Then its local and vocabulary keys no longer apply it
    And the cleared key remains absent after reopening the tagger

  @H2
  Scenario: Server vocabulary changes require durable acknowledgement
    Given the saved user profile contains an older species configuration
    When the tagger is refreshed with its restored session
    Then no vocabulary reconciliation is performed
    When the user explicitly logs in with the current server vocabulary
    Then a blocking message lists added, removed and updated species
    And reopening again does not bypass the required acknowledgement
    When the vocabulary change is acknowledged
    Then removed-species bindings are pruned and the message stays acknowledged

  @H2
  Scenario: A species reference image can be enlarged before deciding
    Given a species row carries a reference image
    When its enlarge control is used
    Then the reference image is shown enlarged over the workspace
    And no tagging keystroke takes effect while it is open
    And Escape, the close control or a click outside dismisses it

  @H2
  Scenario: An upload with nothing to tag offers no species panel at all
    Given an upload whose canonical media list has no images is opened
    Then the workspace states that the upload has no taggable images
    And no species panel is offered
    # Corrected against the app. The file previously claimed "the species rows
    # are disabled and explain that an image must be focused first". That state
    # is unreachable: whenever the panel renders, an image is focused (focus
    # defaults to the first image and every path clamps it into range), and an
    # upload with no taggable images never renders the panel. See CORRECTIONS.md.

  @H2
  Scenario: Dragging a species tile onto the focused image adds it at count one
    Given an image is focused
    When a species tile is dragged onto the image area in the Focus view
    Then that species is recorded on the focused image with a count of one
    And the image's tile shows the species instead of "untagged"

  @H2
  Scenario: Dragging a species already on the image increments its count
    Given the focused image already carries one species
    When that species tile is dragged onto the image area in the Focus view
    Then that species' count is incremented by one

  @H2
  Scenario: Dropping on the focused image does not apply to the current selection
    Given several images are selected
    When a species tile is dragged onto the image area in the Focus view
    Then only the focused image receives the dropped species

  @H2
  Scenario: Dropping a species on an Overview image identifies only that image
    Given several images are selected
    When a species tile is dragged onto a different image tile in Overview
    Then only the Overview image under the drop receives the species

  @H2
  Scenario: Dragging the Ghost tile onto an image replaces its species with Ghost
    Given the focused image already carries one species
    When the Ghost tile is dragged onto the image area in the Focus view
    Then the image is recorded as an empty or false-trigger frame
    And any real species previously on that image is removed

  @H2
  Scenario: New identifications are held locally until they are synced
    When species are applied to images
    Then the identifications are kept in this browser
    And the workspace reports how many local edits are unsaved
    And the collection's stored files are unchanged until a sync is run
