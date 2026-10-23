// FSM lives in a submodule; the top module only wires things.
module top (input clk, input rst_n, input a, output y);
  wire q;
  ctrl u0 (.clk(clk), .rst_n(rst_n), .go(a), .out(q));
  assign y = q;
endmodule

module ctrl (input clk, input rst_n, input go, output reg out);
  parameter S0 = 0, S1 = 1, S2 = 2;
  reg [1:0] st;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) st <= S0;
    else case (st)
      S0: st <= go ? S1 : S0;
      S1: st <= S2;
      S2: st <= go ? S2 : S0;
      default: st <= S0;
    endcase
  always @* out = (st == S2);
endmodule
