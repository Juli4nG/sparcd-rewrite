# DRAFT — for review, not yet agreed. Generated 2026-09-05 from apps/sparcd-uploader (src/sections/Assign.tsx, src/components/CaptureTimeEditor.tsx, src/lib/exifTime.ts, src/lib/estimateCaptureTime.ts, src/lib/spreadCaptureTimes.ts, src/lib/coords.ts, src/lib/bundle.ts, test/exifTime.test.ts, test/estimateCaptureTime.test.ts, test/bundle.test.ts).

@unmapped
Feature: Establish the true capture time of every file

  """
  As-built flow: a camera writes a wall-clock time with no timezone, so the same
  written time means a different instant depending on where the camera stands.
  The uploader records which timezone to read those times in, and defaults it
  from the chosen camera location. When a camera wrote no time at all, the
  uploader estimates one from the files around it rather than asking for it —
  and marks the upload, and each such file, as carrying a known timestamp issue.
  """

  Background:
    Given a scanned batch has reached the Assign step

  @unmapped
  Scenario: The upload timezone starts as this machine's timezone
    Given no deployment has been chosen yet
    Then the upload timezone is the timezone of the machine doing the upload

  @unmapped
  Scenario: Choosing a camera location sets the timezone to that location's timezone
    When a deployment location is chosen
    Then the upload timezone changes to the timezone the location's coordinates fall in
    # Derived from the location's latitude and longitude; approximate near a
    # timezone border.

  @unmapped
  Scenario: A timezone chosen by hand is not overwritten
    Given a deployment location has been chosen
    When the user then picks a different timezone
    Then that choice stands for as long as the same location stays selected

  @unmapped
  Scenario: Any timezone can be selected, including one the machine does not list
    Then the timezone list offers every timezone the browser knows
    And the currently chosen timezone is always offered even if it is not in that list

  @unmapped
  Scenario: Camera times are stored as the instant they represent in the chosen timezone
    Given a file whose camera wrote a wall-clock time
    When the batch is published
    Then the stored capture time is that wall-clock read in the upload timezone
    And daylight-saving time in force on that date is accounted for
    And the stored time does not depend on the timezone of the machine uploading

  @unmapped
  Scenario: A file with no camera time is given the time between its neighbours
    Given some examined files carry no camera capture time
    Then each of them already shows an estimated time, marked as an estimate
    And a file between two timestamped files sits midway between them

  @unmapped
  Scenario: The first and last files are placed ten minutes past their only neighbour
    Given the batch begins and ends with a file carrying no camera time
    Then the first file sits ten minutes before the earliest camera time
    And the last file sits ten minutes after the latest camera time

  @unmapped
  Scenario: A batch with no camera time at all falls back to file modified times
    Given no file in the batch carries a camera capture time
    Then every file takes the time its file was last modified
    And the panel says so, and offers to spread the times instead

  @unmapped
  Scenario: An estimate can be overridden by hand and cleared back
    Given some examined files carry no camera capture time
    When a time is typed over one file's estimate
    Then that file shows the typed time as entered by hand
    And clearing it returns the file to its estimate

  @unmapped
  Scenario: A selection can be spread from a start time
    Given some examined files carry no camera capture time
    When a start time and a spacing are applied to the selection
    Then the files land at that start time, one spacing apart, in filename order
    And each of them is marked as spread

  @unmapped
  Scenario: An impossible date is refused as an override
    When a date that does not exist is entered, such as 31 February
    Then the file keeps the estimate it already had

  @unmapped
  Scenario: Every time the camera did not write is marked as a known issue
    Given some examined files carry no camera capture time
    When the batch is published
    Then the deployment is flagged as having a timestamp issue
    And each file whose time the camera did not write carries a marker saying where it came from
    And files the camera did time carry no marker

  @unmapped
  Scenario: Upload is never blocked by a missing capture time
    Given some examined files carry no camera capture time
    Then the batch can be published without anyone entering a time
