@F6 @wip
Feature: Cross-world entity identity
  As a developer
  I want an entity tracked through renames and moves
  So that history follows the thing, not the filename

  Scenario: Rename and move are recognized
    Given function "fetchUser" in "api/user.ts"
    When it is renamed to "loadUser" and moved to "services/user.ts"
    Then the layer links both as the same entity
    And the link was resolved at Tier 0 or Tier 1 without an LLM call

  Scenario: Same entity diverged across branches
    Given "loadUser" was modified differently on branches A and B
    When I run "git sem entity loadUser --worlds"
    Then I see each branch's version of the entity side by side

  Scenario: Ambiguous identity is surfaced, not decided
    Given two candidates match an entity with similar confidence
    When I query the entity's history
    Then both candidates are shown with confidence
    And I can confirm the correct link
