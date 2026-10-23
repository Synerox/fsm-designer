// SystemVerilog: typedef enum, always_ff / always_comb, unique case, Moore outputs by assign.
module handshake (
  input  logic clk,
  input  logic rst_n,
  input  logic req,
  input  logic ack,
  output logic valid,
  output logic ready
);
  typedef enum logic [1:0] {IDLE, REQUEST, WAIT_ACK, DONE = 2'b11} state_t;
  state_t state, next;

  always_ff @(posedge clk or negedge rst_n)
    if (!rst_n) state <= IDLE;
    else        state <= next;

  always_comb begin
    next = state;
    unique case (state)
      IDLE:     if (req) next = REQUEST;
      REQUEST:  next = WAIT_ACK;
      WAIT_ACK: if (ack) next = DONE;
                else if (!req) next = IDLE;
      DONE:     if (!req) next = IDLE;
    endcase
  end

  assign valid = (state == REQUEST) || (state == WAIT_ACK);
  assign ready = state == DONE;
endmodule
