@F3
Feature: Semantic log
  As a reviewer
  I want history described by meaning, not just messages
  So that I can understand a branch at a glance

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled

  Scenario: Read history by intent without inference
    Given I commit a change to "src/retry.ts" with message "Add retry"
    And I commit a change to "src/quota.ts" with message "Add quota"
    And I run "git sem index"
    When I run "git sem log"
    Then the log lists 2 commits with intents
    And each log entry shows its touched paths
    And the last command did not invoke the engine

  Scenario: Pending commits are marked, not awaited
    Given I commit a change to "src/retry.ts" with message "Add retry"
    And I run "git sem index"
    And I commit a change to "src/quota.ts" with message "Add quota"
    When I run "git sem log"
    Then the newest log entry is marked "pending"
    And the last command did not invoke the engine
