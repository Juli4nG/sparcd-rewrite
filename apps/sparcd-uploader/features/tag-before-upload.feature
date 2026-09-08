# DRAFT — for review, not yet agreed. Generated 2026-08-25 from apps/sparcd-uploader (src/sections/NewUpload.tsx, src/components/FileList.tsx, src/lib/flip.ts, src/lib/bundle.ts, src/lib/siblings.ts) plus packages/flip.

Feature: Identify species before the batch is uploaded

  """
  As-built flow: a third way out of the Inspect step. The batch is handed to
  the Tagger — same browser tab, nothing uploaded, no connection needed — and
  comes back with species on it. The uploader keeps no tagging UI of its own:
  what it shows on return is read-only, and the way to change it is to go back.
  The tags then travel with the images in the same upload; nothing is left for
  a later pass.
  """

  Background:
    Given a folder of media has been scanned
    And the New upload section is showing the Inspect step

  @A1
  Scenario: Tagging is offered as soon as the batch is fit to upload
    Then "Tag species first" sits between "Start over" and "Continue"
    And it is available exactly when Continue is

  @unmapped
  Scenario: A batch that needs attention cannot be tagged yet
    Given one file fails to be examined
    Then "Tag species first" is unavailable
    # Same gate as Continue: a file the uploader could not examine has no
    # identity to tag against.

  @A1
  Scenario: The batch is handed over whole
    When "Tag species first" is chosen
    Then every examined file is handed over with everything the examination established
    And the browser goes to the Tagger carrying the batch's id
    # The batch is rebuilt from the hand-off on the way back and never examined
    # a second time, so anything left behind here is lost for good.

  @cross-tool
  Scenario: The real Tagger reads and returns the Uploader hand-off through the unified dev origin
    When "Tag species first" is chosen through the unified dev origin
    Then the real Tagger opens the batch written by the Uploader
    When Coyote is applied in the real Tagger
    And the real Tagger hands the batch back
    Then the Uploader receives Coyote from the shared hand-off record
    # No step seeds sparcd-flip directly: the Uploader creates the record, the
    # Tagger reads and updates it, and the Uploader consumes it on return.

  @A1
  Scenario: Tags made in the Tagger come back on the batch
    Given a batch was tagged in the Tagger and handed back
    Then the wizard is on the Inspect step with the same files
    And each file still shows the capture time and pixel size the examination found
    And each tagged file shows the species and count it was given
    And files left untagged are shown as untagged
    And the summary says how many files are tagged

  @A1
  Scenario: The tags can be revisited without starting over
    Given a batch was tagged in the Tagger and handed back
    Then the action row offers "Edit tags" instead of "Tag species first"
    And choosing it returns to the Tagger with the same batch id
    # Drafts live in the Tagger, so re-entry picks up where it left off.

  @unmapped
  Scenario: A batch with no remembered folder asks for the folder again
    Given a batch tagged in the Tagger is handed back with no remembered folder
    Then choosing the folder again puts the batch back on the Inspect step
    # A batch dragged in never had a durable folder handle to remember.

  @unmapped
  Scenario: Reopening a remembered folder is asked for, not assumed
    Given a batch tagged in the Tagger is handed back with a folder the browser will not reopen
    Then a "Reopen batch" button is offered instead of the file list
    # A page load is not a user gesture, so the browser is within its rights to
    # refuse; the click is the gesture.

  @A1
  Scenario: The upload carries the images and the identifications together
    Given a batch was tagged in the Tagger and handed back
    When it is published
    Then all stored objects pass the final review
    And observations.csv has one row per species applied, against the right image
    And each row carries the common name the tagger used
    And the upload metadata counts every identified image, empty frames included

  @unmapped
  Scenario: The hand-off is thrown away once its batch is published
    Given a batch was tagged in the Tagger and handed back
    When it is published
    Then nothing about the hand-off is left on this machine
    # It held file paths, fingerprints, thumbnails and possibly a live folder
    # handle. A dry run leaves it alone — nothing was published.

  @unmapped
  Scenario: A dry run keeps the hand-off, so the tags are not lost
    Given a batch was tagged in the Tagger and handed back
    When a dry run of it is started
    Then the hand-off is still on this machine

  @A1
  Scenario: An untagged file is accepted and published as untagged
    Given a batch was tagged in the Tagger and handed back
    When it is published
    Then all stored objects pass the final review
    And the untagged files have no species-identified observation row
    And they are still in media.csv like every other image
    And every media row carries the media type the examination sniffed
    # Not a guess from the file extension: a batch that went through the Tagger
    # must publish the same media.csv as one uploaded straight through.
