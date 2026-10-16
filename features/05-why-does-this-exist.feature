@F5
Feature: Explain an entity's existence
  As a newcomer
  I want to ask why a piece of code exists
  So that I can change it without breaking hidden assumptions

  Background:
    Given a git repository with the semantic layer initialized
    And background indexing is disabled

  Scenario: Explain a function
    Given the semantic engine is the test engine with model "m1"
    And I commit "src/quota.ts" with a function "computeQuota"
    And I run "git sem index"
    And I run "git sem intent HEAD --set 'Introduce per-user quota to stop upload abuse'"
    And I change the function "computeQuota" with message "wip"
    And I run "git sem index"
    And I run "git sem intent HEAD --set 'Exempt admins from the quota'"
    When I run "git sem why computeQuota"
    Then the output contains "Introduce per-user quota to stop upload abuse"
    And the output contains "Exempt admins from the quota"
    And the explanation of "computeQuota" cites 2 commits
    And the last command did not invoke the engine

  Scenario: Insufficient history
    Given the semantic engine is the heuristic engine
    And I import 12 functions including "computeQuota" into "src/legacy.ts" in one commit with message "import legacy code"
    And I run "git sem index"
    When I run "git sem why computeQuota"
    Then the output contains "Recorded intent is insufficient"
    And the output does not contain "import legacy code"
