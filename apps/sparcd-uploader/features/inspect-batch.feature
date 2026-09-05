# DRAFT — for review, not yet agreed. Generated 2026-08-06 from apps/sparcd-uploader (src/sections/NewUpload.tsx, src/components/FileList.tsx, src/lib/validation.ts, src/lib/processing.ts, src/lib/processPool.ts, src/workers/fileProcessor.worker.ts, test/validation.test.ts).

Feature: Inspect the scanned batch before assigning it

  """
  As-built flow: step 2 of 4 ("Inspect"). Every scanned file is examined in the
  background — capture time, camera, dimensions, a thumbnail and a content
  fingerprint — and each file gets a verdict. Problems that would corrupt the
  upload block the batch; everything else is surfaced as a warning the user can
  accept or act on.
  """

  Background:
    Given a folder of media has been scanned
    And the New upload section is showing the Inspect step

  @F1
  Scenario: Every file's capture time and content fingerprint are established before upload
    When the batch is examined
    Then each file's capture time is read from the camera's own metadata
    And each file's content fingerprint is computed from its bytes
    And each image's pixel dimensions and a thumbnail are produced
    # Capture time comes from EXIF for images and from the MP4 container for
    # videos; both are recorded as the camera's wall-clock with no timezone.

  @unmapped
  Scenario: The batch summary reports how much is left to examine
    Given files are still being examined
    Then the summary shows the file count, total size, and how many are still processing
    And it shows how many files need attention and how many carry warnings

  @unmapped
  Scenario: A file that cannot be examined blocks the batch
    Given one file fails to be examined
    Then that file is marked as needing attention
    And the batch cannot continue to the Assign step until it is resolved
    # Resolving it means dropping the file from the batch; there is no retry
    # of a single file's examination.

  @unmapped
  Scenario: A file whose path is unsafe to store blocks the batch
    Given a file's path contains a traversal segment or is empty once normalized
    Then that file is marked as needing attention
    And the batch cannot continue until it is dropped

  @unmapped
  Scenario: A file with no capture time is a warning here, not a blocker
    Given a file carries no camera capture time
    Then it is shown as a warning at Inspect
    And the batch can still continue to the Assign step, where the estimate can be overridden

  @unmapped
  Scenario: Files with identical content are flagged as duplicates
    Given two files in the batch have identical contents
    Then both are flagged as duplicates of each other
    And they are a warning, so the batch can proceed with them kept or dropped

  @unmapped
  Scenario: An unusually large file is flagged but allowed
    Given a file is larger than 100 MiB
    Then it is flagged as unusually large for a camera trap
    And it does not block the batch

  @unmapped
  Scenario: A file can be dropped from the batch
    When a file is removed from the list
    Then it is excluded from the upload
    And the duplicate warnings on the remaining files are recalculated

  @unmapped
  Scenario: Continuing is unavailable while anything needs attention
    Given at least one file is marked as needing attention
    Then the Continue button is disabled
    And it explains that files needing attention must be resolved first

  @unmapped
  Scenario: Assignment can begin before the whole batch has been examined
    Given a large batch is still being examined
    And no file has been marked as needing attention
    Then Continue is available
    And examination carries on in the background while the user works on Assign

  @unmapped
  Scenario: Examination keeps running when the user moves to another section
    Given a batch is still being examined
    When the user switches to History or Settings and back
    Then examination has continued in the background rather than restarting

  @unmapped
  Scenario: Starting over discards the batch
    When "Start over" is chosen
    Then the batch is cleared and the wizard returns to the Files step

  @unmapped
  Scenario: The file list stays usable for a very large batch
    Given a batch of several thousand files
    Then the list scrolls smoothly with only the visible rows drawn
    And files can be stepped through and dropped from the keyboard
