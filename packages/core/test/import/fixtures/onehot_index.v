// One-hot state register written with bit indices.
module onehot_ctrl(input clk, input rst_n, input go, input stop, output run, output idle);
  localparam IDLE = 0, START = 1, RUN = 2, STOP = 3;
  reg [3:0] state, next;

  always @(posedge clk or negedge rst_n)
    if (!rst_n) state <= 4'b0001;
    else state <= next;

  always @(*) begin
    next = 4'b0000;
    case (1'b1)
      state[IDLE]:  if (go) next[START] = 1'b1; else next[IDLE] = 1'b1;
      state[START]: next[RUN] = 1'b1;
      state[RUN]:   if (stop) next[STOP] = 1'b1; else next[RUN] = 1'b1;
      state[STOP]:  next[IDLE] = 1'b1;
    endcase
  end

  assign run  = state[RUN];
  assign idle = state[IDLE];
endmodule
