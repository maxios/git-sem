@F8
Feature: Detect semantic contradictions in clean merges
  As a reviewer
  I want to be warned when a textually clean merge is logically suspect
  So that "merges cleanly" is not mistaken for "is correct"

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled
    And I commit "src/app.ts" with a function "startApp"

  Scenario: Conflicting assumptions
    Given on branch "a" I commit "src/auth/session.ts" with a function "createSession" and message "Auth owns sessions"
    And on branch "b" I commit "src/cache/session.ts" with a function "createSession" and message "Cache owns sessions"
    And I run "git sem index"
    When I run "git sem check a b"
    Then the output contains "src/auth/session.ts"
    And the output contains "src/cache/session.ts"
    And the warning cites the commits "Auth owns sessions" and "Cache owns sessions"
    And the last command did not invoke the engine

  Scenario: Renamed on one side, still used on the other
    Given I commit "src/user.ts" with a function "fetchUser"
    And on branch "a" I rename the function "fetchUser" to "loadUser" in place
    And on branch "b" I commit "src/profile.ts" calling "fetchUser" with message "Show the user profile"
    And I run "git sem index"
    When I run "git sem check a b"
    Then the output contains "a renames fetchUser to loadUser, but b adds uses of fetchUser"
    And the output contains "src/profile.ts"

  Scenario: Warning is non-blocking and the decision is recorded
    Given on branch "a" I commit "src/auth/session.ts" with a function "createSession" and message "Auth owns sessions"
    And on branch "b" I commit "src/cache/session.ts" with a function "createSession" and message "Cache owns sessions"
    And I run "git sem index"
    And I run "git sem check a b"
    When I merge branch "b" into "a"
    Then the merge completes
    When I run "git sem index"
    Then the merge commit records that it was merged despite 1 warning
