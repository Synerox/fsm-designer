// Mealy round-robin-ish arbiter: casez on a request vector, multi-bit outputs.
module arbiter(input clk, input rst_n, input [2:0] req, output reg [2:0] grant, output reg busy);
  localparam [1:0] IDLE = 2'b00, G0 = 2'b01, G1 = 2'b10, G2 = 2'b11;
  reg [1:0] state, nxt;

  always @(posedge clk or negedge rst_n)
    if (!rst_n) state <= IDLE; else state <= nxt;

  always @* begin
    nxt = state;
    grant = 3'b000;
    busy = 1'b0;
    case (state)
      IDLE: casez (req)
        3'b??1: begin nxt = G0; grant = 3'b001; end
        3'b?10: begin nxt = G1; grant = 3'b010; end
        3'b100: begin nxt = G2; grant = 3'b100; end
        default: nxt = IDLE;
      endcase
      G0: begin busy = 1'b1; if (!req[0]) nxt = IDLE; else grant = 3'b001; end
      G1: begin busy = 1'b1; if (!req[1]) nxt = IDLE; else grant = 3'b010; end
      G2: begin busy = 1'b1; if (!req[2]) nxt = IDLE; else grant = 3'b100; end
    endcase
  end
endmodule
