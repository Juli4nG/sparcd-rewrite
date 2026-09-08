# DRAFT — for review, not yet agreed. Generated 2026-08-06 from apps/sparcd-tagger (src/App.tsx, src/store.ts, src/sections/Settings.tsx, src/lib/reset.ts) and packages/auth-ui (Connection.tsx, session.ts).

@unmapped
Feature: Connect the tagger to a collection store and manage the session

  """
  As-built flow: before any tagging is possible the tagger must be given
  S3-compatible credentials. The tool is a static, bring-your-own-credentials
  page — it holds no accounts of its own. Session-level choices (who is
  tagging, whether writes are real, how images are grouped) live in Settings.
  """

  Background:
    Given the tagger is open in a browser

  @unmapped
  Scenario: Connecting requires an endpoint, an access key and a secret key
    Given the connection screen is shown
    When any of the endpoint, access key or secret key is empty
    Then the Connect button is disabled
    And the tagger shows no collections or images

  @unmapped
  Scenario: Backend details are inferred from the endpoint and can be overridden
    Given the connection screen is shown
    When an endpoint is entered
    Then the region, path-style addressing and HTTPS settings are inferred from it
    And those inferred settings are only shown under "Advanced"
    And any of them can be overridden before connecting

  @unmapped
  Scenario: Reloading the page keeps the connection
    Given a successful connection was made earlier in this browser
    When the tagger is opened again in a new page load
    Then it is still connected without asking for the secret again
    # The credentials are held for the life of the tab, so a reload — and a
    # switch to another SPARC'd tool in the same tab — lands back in the app.

  @unmapped
  Scenario: The secret key is never kept on this machine
    Given a successful connection was made earlier in this browser
    When the tab is closed and the tagger is opened in a new one
    Then the endpoint and access key are pre-filled from the previous connection
    And the secret key field is empty
    And the tagger stays on the connection screen until the secret is re-entered

  @unmapped
  Scenario: A second tab picks up a connection that is already open
    Given one tab of a SPARC'd tool is already connected in this browser
    When another tab of the tagger is opened
    Then it adopts the live connection without asking for the secret again
    # A new tab starts with nothing of its own, so this is the live relay
    # between tabs open at the same time; nothing is written to disk, so a tab
    # opened after every other tab is closed must ask for the secret again.

  @unmapped
  Scenario: Disconnecting in one tab disconnects the others
    Given two tabs are connected to the same store
    When one of them disconnects
    Then the other returns to the connection screen
    And it no longer shows the previous connection's collections or images

  @unmapped
  Scenario: The tagging workspace is unreachable until an upload is chosen
    Given the tagger is connected
    When no upload has been opened from Browse
    Then the "Tag" section tab is disabled
    And Browse, History and Settings remain available

  @unmapped
  Scenario: The tagger identity is entered in Settings and stamps every sync
    Given the tagger is connected
    When a tagger identity is entered in Settings
    Then that identity is used for the audit-snapshot path and the edit comment of every sync
    And a live sync or restore cannot be run while the identity is empty
    # The identity is free text typed by the user; the tool does not verify it
    # against the credentials it connected with.

  @unmapped
  Scenario: Writes are a dry-run by default
    Given the tagger is connected
    When Settings is opened for the first time in a session
    Then "Dry-run (log writes, change nothing)" is switched on
    And Sync previews what it would write without changing anything until it is switched off

  @unmapped
  Scenario: Burst grouping is off by default and its window is adjustable
    Given the tagger is connected
    When Settings is opened
    Then "Group rapid sequences into bursts" is switched off
    And the Overview shows a flat strip of images with no burst bands
    And switching it on reveals a threshold between 5 and 600 seconds

  @unmapped
  Scenario: Disconnecting with unsynced edits asks before discarding them
    Given there are unsaved local edits in this browser
    When Disconnect is chosen in Settings
    Then the tagger reports how many unsynced edits exist
    And it offers to cancel, to review the unsynced edits in History, or to discard them and disconnect

  @unmapped
  Scenario: Disconnecting clears this browser's local tagger data
    Given there are no unsaved local edits
    When Disconnect is chosen
    Then local work is cleared while scoped keybinding profiles are retained
    And the tagger returns to the connection screen ready for the next person

  @unmapped
  Scenario: The workspace can be switched between light and dark
    Given the tagger is connected
    When the theme control in the header is used
    Then the workspace switches between the light and dark presentation
    And the choice is remembered on this machine, shared with the other SPARC'd tools
