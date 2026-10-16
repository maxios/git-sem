@F12
Feature: Share semantics with the team
  As a team lead
  I want semantics computed once and shared
  So that every machine does not pay for the same inference

  Background:
    Given a shared remote "origin"
    And "alice" has cloned "origin" with the semantic layer initialized
    And "bob" has cloned "origin" with the semantic layer initialized
    And background indexing is disabled for all teammates

  Scenario: Semantics travel with the repo
    Given I am "alice"
    And the semantic engine is the test engine with model "m1"
    And I commit a change to "src/retry.ts" with message "Add retry"
    And I run "git sem index"
    And I run "git push --quiet origin HEAD:main"
    And I run "git sem push origin"
    When I am "bob"
    And the semantic engine is the test engine with model "m1"
    And I run "git pull --quiet origin main"
    And I run "git sem fetch origin"
    Then the commit "Add retry" has an intent from model "m1"
    And the engine has not been invoked

  Scenario: Divergent semantics are both kept
    Given I am "alice"
    And the semantic engine is the test engine with model "m1"
    And I commit a change to "src/retry.ts" with message "Add retry"
    And I run "git push --quiet origin HEAD:main"
    And I run "git sem index"
    And I am "bob"
    And the semantic engine is the test engine with model "m2"
    And I run "git pull --quiet origin main"
    And I run "git sem index --rev HEAD"
    When I run "git sem push origin"
    And I am "alice"
    And I run "git sem push origin"
    And I am "bob"
    And I run "git sem fetch origin"
    Then the commit "Add retry" has an intent from model "m1"
    And the commit "Add retry" has an intent from model "m2"
