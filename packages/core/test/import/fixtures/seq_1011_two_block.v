module seq_detector_1011(input clk, input rst_n, input x, output reg z);
  localparam IDLE = 2'd0, GOT_1 = 2'd1, GOT_10 = 2'd2, GOT_101 = 2'd3;
  reg [1:0] state, next_state;
  always @(posedge clk or negedge rst_n)
    if (!rst_n) state <= IDLE;
    else state <= next_state;
  always @(*) begin
    next_state = state;
    z = 1'b0;
    case (state)
      IDLE:    if (x) next_state = GOT_1;
      GOT_1:   if (!x) next_state = GOT_10;
      GOT_10:  next_state = x ? GOT_101 : IDLE;
      GOT_101: if (x) begin next_state = GOT_1; z = 1'b1; end else next_state = GOT_10;
    endcase
  end
endmodule
