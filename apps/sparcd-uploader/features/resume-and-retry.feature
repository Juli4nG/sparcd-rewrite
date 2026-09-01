# DRAFT — for review, not yet agreed. Generated 2026-08-06 from apps/sparcd-uploader (src/sections/History.tsx, src/sections/Upload.tsx, src/lib/db.ts, src/lib/resume.ts, src/lib/upload.ts, test/upload.test.ts).

Feature: Resume an interrupted upload and retry a failed one

  """
  As-built flow: every real upload is recorded on this machine as it runs — the
  destination, the deployment, the metadata, and the state of each file. An
  upload that stops part-way stays listed as open and can be picked up later:
  files already stored and verified are skipped, the rest are sent again, and
  the upload lands in exactly the same place as the first attempt.
  """

  Background:
    Given the uploader is connected

  @AL1
  Scenario: Every real upload is recorded so it can be picked up later
    When a real upload starts
    Then the destination, deployment, uploader, description, timezone and the state of every file are recorded on this machine
    And each file's state is updated as it lands

  @unmapped
  Scenario: Dry runs are not recorded
    When a dry run is started
    Then nothing about it appears in History
    # Nothing was written, so there is nothing to resume.

  @AL1
  Scenario: An interrupted upload is listed as open, never as complete
    Given an upload was interrupted before its metadata was published
    When History is opened
    Then that upload is listed as open
    And it shows how many of its files are done and how many failed
    And only uploads whose metadata was published are marked complete

  @AL1
  Scenario: An interrupted upload can be continued from where it stopped
    Given an open upload is listed in History
    When it is resumed
    Then the source folder is re-attached, by permission for a remembered folder or by selecting it again
    And the upload continues from where it stopped
    # As-built continuation is manual: the user clicks Resume. The tool does not
    # detect connectivity returning and does not restart on its own.

  @AL1
  Scenario: Files already stored and verified are not sent again
    Given a resumed upload has files recorded as already stored
    Then each of those objects is re-checked for its size and recorded fingerprint
    And matching objects are skipped rather than uploaded again
    And an object that is missing or does not match is uploaded again

  @AL2
  Scenario: A resumed upload lands in the same place as the original attempt
    When an interrupted upload is resumed
    Then it writes to the same collection, the same upload folder and the same object paths as the original attempt
    And the deployment, uploader identity and description are taken from the recorded session, not re-entered
    And the resumed upload's observations.csv matches what a fresh upload would have written

  @AL2
  Scenario: A partial History-resumed run retries automatically when the tab becomes visible again
    Given an open upload is listed in History
    And the user resumes it and the upload lands as partial
    When the user navigates away from the Upload step
    And the tab regains visibility or the browser comes back online
    Then the partial run retries automatically without any user interaction
    # Regression for #58: the auto-resume effect previously lived only in Upload
    # so navigating away unmounted it and killed the retry. The effect now lives
    # in App so it survives section navigation.

  @AL2
  Scenario: Retrying the failed files of a partial run completes that same upload
    Given a real upload finished as partial with some files failed
    When "Retry failed files" is chosen
    Then only the failed and not-yet-sent files are uploaded
    And the successfully stored files are left alone
    And when they all land, the metadata for that same upload folder is published
    And exactly one upload exists in the destination

  @AL2
  Scenario: Retrying does not require choosing the location again
    When a failed upload is retried or resumed
    Then the collection, deployment, uploader identity and timezone are not asked for again

  @unmapped
  Scenario: The source files are re-checked before anything is sent again
    When an upload is resumed
    Then each recorded file is matched against the selected folder by its relative path, its size and its content fingerprint
    And a file whose content has changed since the original attempt is not uploaded
    And such files are listed with the reason they could not be matched

  @unmapped
  Scenario: A resume that cannot recover every outstanding file refuses to run
    Given some files that are not yet stored cannot be matched in the selected folder
    Then the resume does not start
    And the tool states how many files could not be re-attached and asks for the original folder

  @AL1
  Scenario: An upload interrupted before the batch was fully examined can still be resumed
    Given an upload was interrupted before every file had been examined
    Then no publishable metadata exists for it
    When it is resumed
    Then the remaining files are examined again and the upload completes
    And no data is lost

  @unmapped
  Scenario: Discarding an upload record only removes the local record
    When an upload is discarded from History
    Then its local record and file states are removed from this machine
    And nothing stored in the collection is touched

  @unmapped
  Scenario: A resume in progress can be watched and cancelled
    Given a resume is running
    Then the same per-file progress, byte totals and activity log are shown as for a fresh upload
    And no other upload can be resumed while one is running
    And the resume can be cancelled

  @unmapped
  Scenario: Returning to History keeps a live resume protected
    Given a resume is running
    When the user leaves History and returns while the resume is running
    Then the resumed session cannot be resumed or discarded
    And the resume remains visible and cancellable on the Upload step

  @unmapped
  Scenario: History protects a live run started from New upload
    Given a fresh upload is running in the background
    When History is opened during the fresh upload
    Then its live local session cannot be resumed or discarded

  @unmapped
  Scenario: A retry whose local record cannot be read says so and stays retryable
    Given the local record for a partial run cannot be read
    When "Retry failed files" is chosen
    Then the tool reports that the saved record could not be loaded
    And it suggests retrying, or going back and starting the upload over
    And repeated clicks never start two runs at once
