@F10
Feature: Model upgrades
  As an operator
  I want to adopt better models without breaking existing semantics
  So that upgrades are safe and gradual

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled

  Scenario: New model coexists with old results
    Given I commit a change to "one.ts" with message "one"
    And I commit a change to "two.ts" with message "two"
    And I run "git sem index"
    When the semantic engine model is changed to "m2"
    And I commit a change to "three.ts" with message "three"
    And I run "git sem index"
    Then the commit "one" has an intent from model "m1"
    And the commit "two" has an intent from model "m1"
    And the commit "three" has an intent from model "m2"
    And the commit "one" has no intent from model "m2"

  Scenario: Backfill on demand
    Given I commit a change to "one.ts" with message "one"
    And I commit a change to "two.ts" with message "two"
    And I tag the latest commit as "v2.0"
    And I commit a change to "three.ts" with message "three"
    And I commit a change to "four.ts" with message "four"
    And I run "git sem index"
    When the semantic engine model is changed to "m2"
    And I run "git sem index --since v2.0"
    Then the commit "three" has an intent from model "m2"
    And the commit "four" has an intent from model "m2"
    And the commit "one" has no intent from model "m2"
    And the commit "two" has no intent from model "m2"
    And the commit "one" has an intent from model "m1"

  @wip
  Scenario: Backfill runs in the background
    When I run "git sem index --since v2.0 --background"
    Then the command returns immediately
    And the backfill completes in the background
