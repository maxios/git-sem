@F11
Feature: Tiered escalation
  As an operator
  I want cheap tiers to answer first
  So that latency and cost stay low

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And the frontier engine is the test engine with model "f1"
    And background indexing is disabled
    And I commit "api/user.ts" with a function "fetchUser"
    And I commit "src/account.ts" with a function "loadAccount"
    And on branch "a" I change the function "fetchUser" with message "Cache users for the profile page"
    And on branch "b" I change the function "fetchUser" with message "Hide deleted users"
    And I run "git sem index"
    And I commit a change to "README.md" with message "Explain setup"

  Scenario Outline: Resolve at the cheapest sufficient tier
    When I ask "<question>" with "<command>"
    Then it is answered at tier <tier>
    And no engine above tier <tier> was invoked

    Examples:
      | question                       | command                     | tier |
      | Was this symbol renamed?       | git sem entity fetchUser    | 0    |
      | Which entities are similar?    | git sem similar fetchUser   | 1    |
      | What was this commit's intent? | git sem index --rev HEAD    | 2    |
      | Are these two intents at odds? | git sem check a b --deep    | 3    |

  Scenario: Frontier calls require explicit request
    When I run "git sem index --all"
    Then the frontier engine has been invoked 0 times
    When I run "git sem check a b --deep"
    Then the frontier engine has been invoked 1 time
    And the output contains "Tier 3 review (f1"

  Scenario: Budget cap
    Given the frontier daily budget is 1
    And I run "git sem check a b --deep"
    When I try to run "git sem check a b --deep"
    Then it fails with a message containing "frontier budget exhausted"
    And the frontier engine has been invoked 1 time
    And I run "git sem check a b"
    And I run "git sem index --rev HEAD"
    And I run "git sem entity fetchUser"
