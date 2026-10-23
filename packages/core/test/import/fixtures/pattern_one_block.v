// One always block: state and registered outputs together (Moore by destination).
module pattern_one_block(clk, reset_n, a, b, busy, done);
  input clk, reset_n, a, b;
  output busy, done;
  reg busy, done;
  parameter [2:0] IDLE = 3'd0, LOAD = 3'd1, RUN = 3'd2, WAIT_B = 3'd3, FINISH = 3'd4;
  reg [2:0] state;

  always @(posedge clk or negedge reset_n) begin
    if (~reset_n) begin
      state <= IDLE;
      busy  <= 1'b0;
      done  <= 1'b0;
    end else begin
      case (state)
        IDLE: if (a) begin state <= LOAD; busy <= 1'b1; done <= 1'b0; end
        LOAD: begin state <= RUN; busy <= 1'b1; done <= 1'b0; end
        RUN: begin
          if (a & b) begin state <= FINISH; busy <= 1'b0; done <= 1'b1; end
          else if (a) begin state <= WAIT_B; busy <= 1'b1; done <= 1'b0; end
        end
        WAIT_B: if (b) begin state <= FINISH; busy <= 1'b0; done <= 1'b1; end
        FINISH: begin state <= IDLE; busy <= 1'b0; done <= 1'b0; end
        default: begin state <= IDLE; busy <= 1'b0; done <= 1'b0; end
      endcase
    end
  end
endmodule
