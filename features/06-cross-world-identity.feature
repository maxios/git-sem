@F6
Feature: Cross-world entity identity
  As a developer
  I want an entity tracked through renames and moves
  So that history follows the thing, not the filename

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled
    And I commit "api/user.ts" with a function "fetchUser"
    And I run "git sem index"

  Scenario: Rename and move are recognized
    Given I rename the function "fetchUser" to "loadUser" and move it to "services/user.ts"
    And I run "git sem index"
    When I run "git sem entity loadUser"
    Then the entity "loadUser" is linked to "fetchUser" in "api/user.ts"
    And the lineage of "loadUser" needed no tier above 1
    And the last command did not invoke the engine

  Scenario: Same entity diverged across branches
    Given I rename the function "fetchUser" to "loadUser" and move it to "services/user.ts"
    And branch "a" changes the function "loadUser" to return "from a"
    And branch "b" changes the function "loadUser" to return "from b"
    When I run "git sem entity loadUser --worlds"
    Then branches "a" and "b" each show their own version of "loadUser"

  Scenario: Ambiguous identity is surfaced, not decided
    Given I replace the function "fetchUser" with two copies named "loadUser" and "getUser"
    And I run "git sem index"
    When I run "git sem entity loadUser"
    Then the output lists both "loadUser" and "getUser" as candidates with confidence
    And the entity "loadUser" is not linked to "fetchUser"
    When I run "git sem entity confirm HEAD fetchUser loadUser"
    Then the entity "loadUser" is linked to "fetchUser" in "api/user.ts"

  Scenario: A merge does not repeat its branch's changes
    Given on branch "topic" I rename the function "fetchUser" to "loadUser" in place
    And I merge branch "topic" into "main"
    And I run "git sem index"
    When I run "git sem entity loadUser"
    Then the lineage of "loadUser" reads "renamed, added"

  Scenario: A small function moved to another file keeps its history
    Given I commit "a.ts" containing:
      """
      export function countSlots(range) {
        let n = 0;
        each(range, () => n++);
        return n;
      }
      """
    And I move "a.ts" to "lib/a.ts" replacing "each(" with "forEach("
    And I run "git sem index"
    When I run "git sem entity countSlots"
    Then the lineage of "countSlots" reads "moved, added"
