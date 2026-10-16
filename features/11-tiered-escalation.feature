@F11 @wip
Feature: Tiered escalation
  As an operator
  I want cheap tiers to answer first
  So that latency and cost stay low

  Scenario Outline: Resolve at the cheapest sufficient tier
    Given a "<question>" about the repository
    When the layer resolves it
    Then it is answered at "<tier>"
    And higher tiers are not invoked

    Examples:
      | question                       | tier   |
      | Was this symbol renamed?       | Tier 0 |
      | Which entities are similar?    | Tier 1 |
      | What was this commit's intent? | Tier 2 |
      | Are these two intents at odds? | Tier 3 |

  Scenario: Frontier calls require explicit request
    Given Tier 3 is configured as "on demand"
    When background indexing runs
    Then no Tier 3 calls are made
    And Tier 3 is used only when I invoke a command that needs it

  Scenario: Budget cap
    Given a daily Tier 3 budget is set
    When the budget is exhausted
    Then Tier 3 requests are refused with a clear message
    And Tiers 0 to 2 continue to work
