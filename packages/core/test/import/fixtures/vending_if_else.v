// Mealy vending machine: if/else chains on state, case on a 2-bit coin input,
// parameters in the module header, an enable that holds the state.
module vending #(parameter W = 2, parameter [W-1:0] S0 = 0, S5 = 1, S10 = 2, S15 = 3) (
  input clk, input rst, input en,
  input [1:0] coin,      // 00 none, 01 nickel, 10 dime
  output reg vend,
  output reg change
);
  reg [W-1:0] state, next_state;

  always @(posedge clk or posedge rst) begin
    if (rst) state <= S0;
    else if (en) state <= next_state;
  end

  always @(*) begin
    next_state = state; vend = 0; change = 0;
    if (state == S0) begin
      case (coin)
        2'b01: next_state = S5;
        2'b10: next_state = S10;
      endcase
    end else if (state == S5) begin
      case (coin)
        2'b01: next_state = S10;
        2'b10: next_state = S15;
      endcase
    end else if (state == S10) begin
      if (coin == 2'b01) next_state = S15;
      else if (coin == 2'b10) begin next_state = S0; vend = 1; end
    end else begin
      if (coin == 2'b01) begin next_state = S0; vend = 1; end
      else if (coin == 2'b10) begin next_state = S0; vend = 1; change = 1; end
    end
  end
endmodule
