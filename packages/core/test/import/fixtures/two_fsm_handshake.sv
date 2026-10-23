// Two cooperating FSMs in one module (producer / consumer).
module pc (
  input  logic clk, rst_n, start, ack_in,
  output logic req, done, busy
);
  typedef enum logic [1:0] {P_IDLE, P_REQ, P_WAIT, P_DONE} p_t;
  typedef enum logic [1:0] {C_IDLE, C_WORK, C_ACK} c_t;
  p_t p, p_n;
  c_t c, c_n;
  logic got;

  always_ff @(posedge clk or negedge rst_n)
    if (!rst_n) begin p <= P_IDLE; c <= C_IDLE; end
    else begin p <= p_n; c <= c_n; end

  always_comb begin
    p_n = p;
    unique case (p)
      P_IDLE: if (start) p_n = P_REQ;
      P_REQ:  p_n = P_WAIT;
      P_WAIT: if (got) p_n = P_DONE;
      P_DONE: p_n = P_IDLE;
    endcase
  end

  always_comb begin
    c_n = c;
    case (c)
      C_IDLE: if (p == P_REQ) c_n = C_WORK;
      C_WORK: if (ack_in) c_n = C_ACK;
      C_ACK:  c_n = C_IDLE;
      default: c_n = C_IDLE;
    endcase
  end

  assign got  = (c == C_ACK);
  assign req  = (p == P_REQ) || (p == P_WAIT);
  assign done = (p == P_DONE);
  assign busy = (c != C_IDLE);
endmodule
