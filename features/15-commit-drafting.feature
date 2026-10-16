@F15
Feature: History-aware commit drafting
  As a developer writing a commit
  I want a draft that knows what the touched code was for
  So that my message explains why, and I notice when I undo a past decision

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled

  Scenario: The draft is informed by the history of the touched files
    Given I commit a change to "src/retry.ts" with message "wip"
    And I commit a change to "src/quota.ts" with message "Add quota"
    And I run "git sem index"
    And I run "git sem intent HEAD~1 --set 'Cap retries at three to avoid thundering herd'"
    And I run "git sem intent HEAD --set 'Limit uploads per user'"
    And I stage a change to "src/retry.ts"
    When I run "git sem commit --draft"
    Then the engine received the intent "Cap retries at three to avoid thundering herd" as history
    And the engine did not receive the intent "Limit uploads per user" as history
    And the output contains "Cap retries at three to avoid thundering herd"
    And the last command invoked the engine 1 time

  Scenario: Undoing a recorded change is flagged
    Given I commit "config.env" with content "RETRIES=3"
    And I commit "config.env" with content "RETRIES=5"
    And I run "git sem index"
    And I run "git sem intent HEAD --set 'Raise retries to five for the flaky upstream'"
    And I stage "config.env" with content "RETRIES=3"
    When I run "git sem commit --draft"
    Then the draft warns that it reverts the commit "Set config.env to RETRIES=5"
    And the output contains "Raise retries to five for the flaky upstream"

  Scenario: The draft asks instead of inventing a reason
    Given the semantic engine is the heuristic engine
    And I stage a change to "src/new.ts"
    When I run "git sem commit --draft"
    Then the draft asks why the change was made

  Scenario: Drafting commits and stores nothing
    Given I stage a change to "src/new.ts"
    When I run "git sem commit --draft"
    Then there are no commits yet
    And no artifacts are stored

  Scenario: Committing with the draft records it as my intent
    Given I stage a change to "src/retry.ts"
    When I run "git sem commit --no-edit"
    Then HEAD shows an authored intent starting with "[m1]"
    And the message of HEAD has no comment lines

  Scenario: Plain git commit never waits for a draft
    Given I stage a change to "src/retry.ts"
    When I run "git commit --quiet -m 'Add retry'"
    Then the engine has not been invoked
