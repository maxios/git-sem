@F2
Feature: Intent capture
  As a developer
  I want the "why" of a change recorded alongside the "what"
  So that intent becomes a first-class, durable fact

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled

  Scenario: Proposed intent from staged changes
    Given I stage a change to "src/retry.ts"
    When I run "git sem intent --staged"
    Then the output contains a proposed intent
    And no artifacts are stored

  Scenario: User-authored intent wins
    Given I commit a change to "src/retry.ts" with message "wip"
    And I run "git sem index"
    When I run "git sem intent HEAD --set 'Cap retries at three attempts'"
    Then HEAD shows the authored intent "Cap retries at three attempts"
    And HEAD keeps its inferred intent as provenance

  Scenario: Accepting a proposal makes it authored
    Given I commit a change to "src/retry.ts" with message "wip"
    And I run "git sem index"
    When I run "git sem intent HEAD --accept"
    Then HEAD shows an authored intent starting with "[m1]"

  Scenario: Intent rolls up to the branch
    Given I commit a change to "README.md" with message "Start"
    And branch "feature/timeouts" has 5 commits with intents
    When I run "git sem intent --branch feature/timeouts --base main"
    Then the output contains "Branch intent: [m1] summary of 5 intents"
    And the output contains "5 commits, 5 with intents"
    And the last command invoked the engine 1 time
