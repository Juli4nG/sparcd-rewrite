# DRAFT — for review, not yet agreed. Generated 2026-08-06 from apps/sparcd-tagger (src/sections/Tag.tsx — handleKey/SortBar/find-image, src/components/Overview.tsx, src/components/Cheatsheet.tsx, src/lib/selection.ts, src/lib/bursts.ts, src/lib/sortImages.ts, src/lib/imageSearch.ts).

@unmapped
Feature: Move through an upload and choose which images an action applies to

  """
  As-built flow: the workspace has an Overview (grid or list) and a Focus view
  of one image. Keyboard accelerators drive navigation and selection so a long
  upload can be worked through without the mouse; every keyboard action has an
  on-screen equivalent for touch.
  """

  Background:
    Given an upload is open in the tagging workspace

  @unmapped
  Scenario: The upload can be surveyed as a grid or as a list
    Then the Overview can be switched between a grid of tiles and a list of rows
    And the workspace shows the position of the focused image within the upload
    And the Focus view keeps the list alongside the enlarged image

  @unmapped
  Scenario: List rows expose the useful image details without ambiguous status clutter
    Given an image has a corrected timestamp and meaningful review markers
    When the detailed Overview list is opened
    Then list columns follow the Name, Type, Date, Species sort-control order
    And image and video rows identify their media type
    And capture timestamps show corrected and unavailable values accurately
    And long column values preserve their full accessible text
    And row numbers and the old species indicator are absent
    And meaningful edit and questionable markers remain accessible
    And a narrow Overview keeps filenames visible in its compact rows
    And the Focus strip keeps filename and species but omits the detail columns

  @unmapped
  Scenario: Images can be stepped through from the keyboard
    When the next-image or previous-image key is pressed
    Then focus moves one image in that direction
    And it stops at the first and last image of the upload
    And any selection is cleared by the move

  @unmapped
  Scenario: An image can be opened from the Overview and paged from the Focus view
    Given the Overview is shown
    When the focused image is opened
    Then the Focus view shows that image
    And on-screen previous and next controls move between images there

  @unmapped
  Scenario: The upload can be ordered by name, type, date or species count
    When a sort field is chosen
    Then the images are ordered by that field
    And choosing the same field again reverses the order
    And images that tie keep their original file order

  @unmapped
  Scenario: Re-ordering keeps focus and selection on the same images
    Given some images are selected and one is focused
    When the sort order is changed
    Then the same images remain selected
    And the same image remains focused, at its new position

  @unmapped
  Scenario: An image can be found by its file name
    When part of a file name is typed into the image search
    Then focus jumps to the first matching image
    And the number of matches and the current match position are shown
    And the matches can be cycled forwards and backwards
    And clearing the search leaves the upload's order untouched

  @unmapped
  Scenario: Images are selected by clicking, extending or adding
    Given the Overview is shown
    When an image is clicked
    Then only that image is selected as the focus
    And shift-clicking another image selects the whole range between them
    And command- or control-clicking adds or removes a single image from the selection

  @unmapped
  Scenario: A selection can be built and cleared without a pointer
    Then a selected count is shown in place of the position when a selection exists
    And pressing Escape clears the selection
    And an on-screen control adds or removes the focused image from the selection on touch

  @unmapped
  Scenario: Rapid sequences can be grouped and worked as a unit
    Given burst grouping is switched on in Settings
    Then images from the same camera taken within the configured window are banded together
    And each band states how many images it holds and the time it spans
    And the whole band can be selected in one action
    And the burst-forward and burst-back keys jump between bands

  @unmapped
  Scenario: A missing capture time never merges two sequences
    Given an image has no capture time
    Then it starts a new burst rather than joining the previous one

  @unmapped
  Scenario: The keyboard accelerators are discoverable
    When the help key is pressed or the on-screen help control is used
    Then the shortcut reference is shown, grouped by navigating, tagging and selecting
    And it can be dismissed with the same key, with Escape, or with its close control
    And no tagging or navigation keystroke takes effect while it is open

  @unmapped
  Scenario: Accelerators stand down while text is being typed
    Given the cursor is in a text field
    Then letter keys type into that field rather than applying species
    And pressing Enter in the species filter applies the top match and leaves the field
    And pressing Enter in the image search moves to the next match instead of tagging

  @unmapped
  Scenario: Accelerators stand down while a video or a dialog has the keyboard
    Given a video is being played or scrubbed
    Then its own playback keys work and no tagging keystroke fires
    And while the sync, snapshots or time-shift dialog is open no image behind it is tagged or navigated
