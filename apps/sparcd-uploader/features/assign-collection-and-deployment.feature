# DRAFT — for review, not yet agreed. Generated 2026-08-06 from apps/sparcd-uploader (src/sections/Assign.tsx, src/components/CollectionPicker.tsx, src/sections/Upload.tsx, src/lib/s3.ts, src/lib/locations.ts, src/lib/useCollections.ts, test/locations.test.ts).

Feature: Assign a batch to a collection and a camera location

  """
  As-built flow: step 3 of 4 ("Assign"). Before a batch can be uploaded the user
  says where it belongs — which collection receives it, which camera location
  (deployment) the SD card came from, who is uploading it, and optionally a
  description. Nothing can be uploaded until all of that is settled.
  """

  Background:
    Given a scanned batch has passed the Inspect step
    And the New upload section is showing the Assign step

  @F2 @A2
  Scenario: The batch cannot be uploaded until a camera location is assigned
    Given no deployment location has been chosen
    Then the Continue button is disabled
    And it states that a deployment location must be selected first

  @F2 @A2
  Scenario: A target collection is always in force, and one is chosen automatically
    Given the collections readable with the connected credentials have been listed
    Then the first of them is already selected
    And the Continue gate never has to ask for a collection
    # Correction: the file previously claimed the gate blocks until a target
    # collection is chosen. As-built the first readable collection is
    # pre-selected and nothing can clear it, and when no collection is readable
    # the deployment picker never appears at all — so the "select a target
    # collection first" message in the code is unreachable.

  @unmapped
  Scenario: The batch cannot be uploaded until an uploader identity is set
    Given the uploader identity is empty
    Then the Continue button is disabled
    And it states that an uploader identity must be set first

  @unmapped
  Scenario: The batch cannot be uploaded while any examined file lacks a capture time
    Given at least one examined file has neither a camera capture time nor a manual one
    Then the Continue button is disabled
    And it states that a capture time is needed for every file missing one

  @unmapped
  Scenario: The collections offered are the ones the connection can actually read
    When the Assign step opens
    Then the tool lists the collections readable with the connected credentials
    And the first of them is pre-selected
    And each is shown with its name and its organization or contact, and the selected one's identifier is shown beneath the list
    # Correction: the identifier is not on each row — the list shows name,
    # organization · contact, and description; the chosen collection's uuid is
    # printed underneath the picker.

  @unmapped
  Scenario: A connection that can see no collections explains what is missing
    Given the connected credentials can read no collection
    Then the tool states that credentials able to read a collection's descriptor are required, and that the bucket must allow this web origin

  @F2 @A2
  Scenario: Locations the chosen collection has already used are offered first
    Given the chosen collection has already published uploads for some locations
    When the deployment list is shown
    Then those already-used locations are listed first
    And the list states how many of the registry's locations that collection has used
    # Deviation from the story: as-built ANY location in the registry can be
    # assigned, not only locations valid for the chosen collection. The
    # already-used set is an ordering hint, not a restriction.

  @unmapped
  Scenario: The location list can be searched
    When part of a location's name or identifier is typed
    Then the list narrows to the matching locations
    And a location can be chosen with the keyboard or by clicking it

  @unmapped
  Scenario: A location's elevation can be checked before committing to it, with no coordinates shown
    When a location's details are opened
    Then its elevation in both metres and feet is shown, with no coordinates

  @unmapped
  Scenario: Two locations sharing an identifier are kept apart
    Given the location registry contains two entries with the same identifier but different coordinates
    Then both are offered as separate locations
    And an entry repeated with identical identifier and coordinates is offered once
    # The registry's identifier is not unique; identity here is the identifier
    # plus the coordinates.

  @unmapped
  Scenario: A malformed entry in the location registry does not sink the list
    Given the registry contains entries with a missing name, an out-of-range coordinate, or an unset elevation
    Then those entries are left out of the list
    And every valid entry is still offered

  @unmapped
  Scenario: A registry that cannot be read is reported plainly
    Given the location registry cannot be read with the connected credentials
    Then the Assign step explains that the registry could not be loaded
    And no deployment can be chosen until it can be read

  @unmapped
  Scenario: The uploader identity typed here carries through to its key-safe form in Settings
    When an uploader identity is typed
    Then the tool shows the key-safe form of it that will appear in the upload's storage path and object names
    # The identity is free text; the tool does not check it against the
    # credentials it connected with. Assign itself only holds the raw
    # identity — the key-safe preview lives in Settings, since that field is
    # the same shared uploaderUser Assign just set.

  @unmapped
  Scenario: A description can be recorded with the batch
    When a description is entered
    Then it is stored as the upload's description in the upload's metadata file

  @unmapped
  Scenario: Exact deployment metadata is not exposed before uploading
    Given a collection, a deployment and an uploader identity have been chosen
    When the Upload step is opened
    Then no bundle Preview control or generated metadata contents are offered

  @unmapped
  Scenario: Removing Preview does not change the published metadata bundle
    Given a collection, a deployment and an uploader identity have been chosen
    When the Upload step is opened
    And a real upload is started and completes
    Then the complete metadata bundle is still written
    # The diagnostic preview remains available only on debug/metadata-preview.
