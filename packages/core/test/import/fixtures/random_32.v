module rand32 (input clk, input rst_n, input [1:0] in, output reg [3:0] o);
  localparam S0 = 5'd0, S1 = 5'd1, S2 = 5'd2, S3 = 5'd3, S4 = 5'd4, S5 = 5'd5, S6 = 5'd6, S7 = 5'd7, S8 = 5'd8, S9 = 5'd9, S10 = 5'd10, S11 = 5'd11, S12 = 5'd12, S13 = 5'd13, S14 = 5'd14, S15 = 5'd15, S16 = 5'd16, S17 = 5'd17, S18 = 5'd18, S19 = 5'd19, S20 = 5'd20, S21 = 5'd21, S22 = 5'd22, S23 = 5'd23, S24 = 5'd24, S25 = 5'd25, S26 = 5'd26, S27 = 5'd27, S28 = 5'd28, S29 = 5'd29, S30 = 5'd30, S31 = 5'd31;
  reg [4:0] state, next;
  always @(posedge clk or negedge rst_n) if (!rst_n) state <= S0; else state <= next;
  always @(*) begin
    next = state; o = 4'd0;
    case (state)
      S0: begin o = 4'd0; if (in == 2'b01) next = S1; else if (in == 2'b10) next = S2; else if (in == 2'b11) next = S18; end
      S1: begin o = 4'd1; if (in == 2'b01) next = S2; else if (in == 2'b10) next = S15; else if (in == 2'b11) next = S4; end
      S2: begin o = 4'd2; if (in == 2'b01) next = S3; else if (in == 2'b10) next = S22; else if (in == 2'b11) next = S0; end
      S3: begin o = 4'd3; if (in == 2'b01) next = S4; else if (in == 2'b10) next = S27; else if (in == 2'b11) next = S23; end
      S4: begin o = 4'd4; if (in == 2'b01) next = S5; else if (in == 2'b10) next = S24; else if (in == 2'b11) next = S0; end
      S5: begin o = 4'd5; if (in == 2'b01) next = S6; else if (in == 2'b10) next = S20; else if (in == 2'b11) next = S4; end
      S6: begin o = 4'd6; if (in == 2'b01) next = S7; else if (in == 2'b10) next = S27; else if (in == 2'b11) next = S6; end
      S7: begin o = 4'd7; if (in == 2'b01) next = S8; else if (in == 2'b10) next = S14; else if (in == 2'b11) next = S31; end
      S8: begin o = 4'd8; if (in == 2'b01) next = S9; else if (in == 2'b10) next = S15; else if (in == 2'b11) next = S18; end
      S9: begin o = 4'd9; if (in == 2'b01) next = S10; else if (in == 2'b10) next = S14; else if (in == 2'b11) next = S20; end
      S10: begin o = 4'd10; if (in == 2'b01) next = S11; else if (in == 2'b10) next = S3; else if (in == 2'b11) next = S29; end
      S11: begin o = 4'd11; if (in == 2'b01) next = S12; else if (in == 2'b10) next = S2; else if (in == 2'b11) next = S20; end
      S12: begin o = 4'd12; if (in == 2'b01) next = S13; else if (in == 2'b10) next = S4; else if (in == 2'b11) next = S22; end
      S13: begin o = 4'd13; if (in == 2'b01) next = S14; else if (in == 2'b10) next = S22; else if (in == 2'b11) next = S23; end
      S14: begin o = 4'd14; if (in == 2'b01) next = S15; else if (in == 2'b10) next = S8; else if (in == 2'b11) next = S31; end
      S15: begin o = 4'd15; if (in == 2'b01) next = S16; else if (in == 2'b10) next = S11; else if (in == 2'b11) next = S2; end
      S16: begin o = 4'd0; if (in == 2'b01) next = S17; else if (in == 2'b10) next = S30; else if (in == 2'b11) next = S7; end
      S17: begin o = 4'd1; if (in == 2'b01) next = S18; else if (in == 2'b10) next = S18; else if (in == 2'b11) next = S15; end
      S18: begin o = 4'd2; if (in == 2'b01) next = S19; else if (in == 2'b10) next = S7; else if (in == 2'b11) next = S15; end
      S19: begin o = 4'd3; if (in == 2'b01) next = S20; else if (in == 2'b10) next = S6; else if (in == 2'b11) next = S26; end
      S20: begin o = 4'd4; if (in == 2'b01) next = S21; else if (in == 2'b10) next = S18; else if (in == 2'b11) next = S28; end
      S21: begin o = 4'd5; if (in == 2'b01) next = S22; else if (in == 2'b10) next = S20; else if (in == 2'b11) next = S21; end
      S22: begin o = 4'd6; if (in == 2'b01) next = S23; else if (in == 2'b10) next = S6; else if (in == 2'b11) next = S13; end
      S23: begin o = 4'd7; if (in == 2'b01) next = S24; else if (in == 2'b10) next = S8; else if (in == 2'b11) next = S17; end
      S24: begin o = 4'd8; if (in == 2'b01) next = S25; else if (in == 2'b10) next = S0; else if (in == 2'b11) next = S31; end
      S25: begin o = 4'd9; if (in == 2'b01) next = S26; else if (in == 2'b10) next = S31; else if (in == 2'b11) next = S25; end
      S26: begin o = 4'd10; if (in == 2'b01) next = S27; else if (in == 2'b10) next = S10; else if (in == 2'b11) next = S15; end
      S27: begin o = 4'd11; if (in == 2'b01) next = S28; else if (in == 2'b10) next = S21; else if (in == 2'b11) next = S21; end
      S28: begin o = 4'd12; if (in == 2'b01) next = S29; else if (in == 2'b10) next = S2; else if (in == 2'b11) next = S12; end
      S29: begin o = 4'd13; if (in == 2'b01) next = S30; else if (in == 2'b10) next = S14; else if (in == 2'b11) next = S13; end
      S30: begin o = 4'd14; if (in == 2'b01) next = S31; else if (in == 2'b10) next = S31; else if (in == 2'b11) next = S28; end
      S31: begin o = 4'd15; if (in == 2'b01) next = S0; else if (in == 2'b10) next = S21; else if (in == 2'b11) next = S9; end
      default: next = S0;
    endcase
  end
endmodule
