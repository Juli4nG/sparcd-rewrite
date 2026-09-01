# DRAFT — for review, not yet agreed. Generated 2026-08-06 from apps/sparcd-uploader (src/sections/Upload.tsx, src/lib/upload.ts, src/lib/bundle.ts, src/components/RunMonitor.tsx, packages/s3-safe/src/index.ts, test/upload.test.ts, test/bundle.test.ts).

Feature: Upload and publish a batch

  """
  As-built flow: step 4 of 4 ("Upload"). The batch's media is streamed to the
  collection under a single upload folder, each object verified after it lands.
  Only once every file has landed are the metadata files written — that final
  write is what makes the upload visible to the rest of SPARC'd, so a partly
  transferred batch never looks like a finished one.
  """

  Background:
    Given a batch has a collection, a deployment, an uploader identity and capture times
    And the New upload section is showing the Upload step
    # PR #26 fixed the old publish hang for fully examined batches. Scenarios
    # now use ordinary small media, except where the behavior under test is
    # explicitly about background examination or cancelling an in-flight write.

  @unmapped
  Scenario: The status indicator in the title bar explains its state on hover and focus
    Given the upload has not been started
    Then the ready status explains itself on hover and keyboard focus
    When a real upload is started and completes
    Then the complete status explains itself on hover and keyboard focus

  @unmapped
  Scenario: A real upload is offered by default; a dry run is opt-in
    Given the upload has not been started
    Then dry run is switched off by default
    # Dry run resets to off for every new page load; it is not remembered.

  @unmapped
  Scenario: Switching dry run on lists every object that would be written, without writing it
    Given the upload has not been started
    When the operator opts into a dry run
    Then starting it lists every object that would be written, with its size and fingerprint
    And nothing is written to storage
    And the run is not recorded in History

  @A1
  Scenario: The title-bar pill shows dry-run during blob processing and after completion
    Given some files are still being examined
    When the operator opts into a dry run
    And the dry run is started
    Then the title-bar pill and tooltip show dry-run while blobs are processing and after completion

  @unmapped
  Scenario: A real upload states what access it needs before it starts
    Then the tool states that a setup issue on the storage side is not the user's fault
    And that the collection ID is given to contact an administrator with

  @F1
  Scenario: Every file in the batch is stored under one upload folder in the collection
    When a real upload is started and completes
    Then every media file of the batch is stored under a single upload folder in the chosen collection
    And the folder is named for the moment of upload and the uploader's identity
    And each stored object's path is the one recorded for it in the media table

  @unmapped
  Scenario: The completion dialog reports how many files were published and to which collection
    When a real upload completes without dismissing its confirmation
    Then the completion dialog states the file count and collection ID
    And dismissing it closes the dialog

  @F1
  Scenario: Every stored object is confirmed once the batch is written
    When a file has been uploaded
    Then the tool lists the upload folder and confirms every object is stored at its recorded size
    And a few of the stored objects are re-read to confirm storage kept their recorded fingerprint
    And an object the listing contradicts is treated as a failure of that file, not as a success
    And an object whose sha256 fingerprint is absent from storage is treated as a failure
    # One listing pass per thousand objects rather than a re-read per file: at
    # long-haul latency the extra round trip per file dominated a small upload,
    # and the listing answers the question that matters — is every object there,
    # at the size the metadata claims for it. A listing can't show the recorded
    # fingerprint, so a handful of objects are re-read for it — losing it is a
    # property of the path, not of one object.

  @unmapped
  Scenario: Uploading begins before the whole batch has finished being examined
    Given some files are still being examined
    When the upload is started
    Then files that have already been examined start uploading immediately
    And each remaining file starts as soon as its own examination finishes
    And the tool reports how many files are still being examined

  @F1
  Scenario: A run that started mid-inspection completes even after the user navigates to another section
    Given a streaming run has started with one file still being examined
    When the user navigates to the History section
    And the held file finishes being examined
    And the user returns to the New upload section
    Then the run completes successfully

  @F1 @F3
  Scenario: The upload is only published once every file has landed
    Given a real upload is running
    Then the metadata files are written only after every file in the batch has been stored and verified
    And they are written in a fixed order, with the upload metadata file last but one and the completion record last
    # Upstream SPARC'd treats the presence of the upload metadata file as the
    # signal that the folder is complete, which is why it is written after the
    # media and the tables.

  @F1
  Scenario: A batch where some files failed is left unpublished and shown as partial
    Given a real upload in which some files failed after their retries
    Then no metadata files are written
    And the run is reported as partial, stating how many files failed
    And the tool states that the upload is not yet visible and can be completed by retrying the failed files

  @F3
  Scenario: An upload that fails or is abandoned announces nothing
    Given a real upload that was cancelled or ended in failure
    Then no upload metadata file was written for it
    And nothing reading the collection sees a new upload there
    # There is no notification mechanism as-built; publishing the metadata is the
    # only thing that makes an upload discoverable.

  @A1
  Scenario: A batch with no species identifications is accepted and recorded as untagged
    When a batch is published
    Then a placeholder observations table is written alongside the media table
    And the upload metadata records that none of its images carry a species
    And each blank row's observation ID is the path-relative filename followed by ":0"
    # The uploader has no tagging surface at all; every upload it makes is
    # untagged by construction.

  @A1
  Scenario: Two untagged files with the same name in different subfolders get distinct observation IDs
    Given a batch contains two files with the same filename under different subfolders
    When a batch is published
    Then each file's blank row carries a distinct path-scoped observation ID

  @unmapped
  Scenario: Progress is reported per file and for the batch as a whole
    Given a run is in progress
    Then each file shows its own state and percentage
    And the batch shows bytes uploaded against the total, and counts of done, skipped and failed files
    And an activity log records each retry, each warning and each metadata write as it happens
    # Correction: a real upload does not log successful blob writes at all — the
    # log carries retries, warnings, skips, and the five metadata writes. The
    # per-object "PUT …" listing only appears in a dry run.

  @unmapped
  Scenario: The number of files uploaded at once can be tuned
    Given the upload has not been started
    Then the number of parallel uploads is chosen automatically by default
    And it can be pinned to a number between 4 and 32
    And a pinned number defaults to 8
    And a pinned number can be changed while a run is in progress
    # Choosing automatic or pinned is a Settings choice, remembered for the
    # rest of the browser session. Once pinned, the slider also appears on the
    # Upload step and stays live while a run is going.

  @unmapped
  Scenario: A momentary failure is retried before the file is given up on
    Given a file's upload fails with a network error, a server error or a clock-skew rejection
    Then it is retried up to five attempts with an increasing, randomized delay
    And the retry is recorded in the activity log

  @unmapped
  Scenario: A permission failure stops the whole run at once
    Given a file's upload is refused for lack of permission
    Then the run stops immediately without working through the remaining files
    And the failure is reported

  @unmapped
  Scenario: Many independent file failures are treated as a systemic problem
    Given ten files have failed independently in one run
    Then the run stops and reports that the problem looks systemic rather than per-file

  @unmapped
  Scenario: A lane stuck offline after a systemic abort surfaces the error without waiting for the network
    Given a run aborts systemically while some lanes are waiting for the network
    Then the error screen is shown immediately
    And the run does not wait for the network to return before reporting the failure

  @unmapped
  Scenario: An object already present at the same path is never silently overwritten
    Given an object already exists at a path the run intends to write
    When a fresh upload attempts that write
    Then the write is refused rather than replacing the existing object
    And the run reports the failure
    # The storage wrapper offers no delete or copy operation, and its only
    # overwrite path is the reviewed edit-after-publish flow.

  @unmapped
  Scenario: A run can be cancelled
    When a run is cancelled
    Then in-flight transfers are abandoned
    And the run is reported as cancelled
    And files already stored remain stored
    # Cancelling a real run leaves the session open in History, so it can be
    # resumed later.

  @unmapped
  Scenario: Going back to Assign is blocked while a run is in progress
    Given a run is in progress
    Then the Back button is disabled

  @unmapped
  Scenario: The next batch from the same site keeps the previous choices
    Given a real upload has completed
    When "Next batch" is chosen
    Then the wizard returns to the Files step with an empty batch
    And the collection, deployment, uploader identity, description and timezone of the previous batch are kept

  @unmapped
  Scenario: The screen wake lock is held while a dry run is in progress
    Given the browser wake lock API is available in this session
    When the operator opts into a dry run
    And the dry run is started and completes
    Then the browser wake lock was requested

  @unmapped
  Scenario: The preparing phase is logged and the wake lock is held before the first blob lands
    Given the browser wake lock API is available in this session
    And the first media blob is held at the mock
    When a real upload is started
    Then the activity log has the preparing-upload entry
    And the browser wake lock was requested
    And releasing the held blob lets the upload complete
