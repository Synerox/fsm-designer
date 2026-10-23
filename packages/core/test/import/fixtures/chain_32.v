module seq32 (input clk, input rst, input step, output reg last);
  reg [4:0] st;
  localparam P0 = 5'd0, P1 = 5'd1, P2 = 5'd2, P3 = 5'd3, P4 = 5'd4, P5 = 5'd5, P6 = 5'd6, P7 = 5'd7, P8 = 5'd8, P9 = 5'd9, P10 = 5'd10, P11 = 5'd11, P12 = 5'd12, P13 = 5'd13, P14 = 5'd14, P15 = 5'd15, P16 = 5'd16, P17 = 5'd17, P18 = 5'd18, P19 = 5'd19, P20 = 5'd20, P21 = 5'd21, P22 = 5'd22, P23 = 5'd23, P24 = 5'd24, P25 = 5'd25, P26 = 5'd26, P27 = 5'd27, P28 = 5'd28, P29 = 5'd29, P30 = 5'd30, P31 = 5'd31;
  always @(posedge clk) if (rst) st <= P0; else case (st)
    P0: if (step) st <= P1;
    P1: if (step) st <= P2;
    P2: if (step) st <= P3;
    P3: if (step) st <= P4;
    P4: if (step) st <= P5;
    P5: if (step) st <= P6;
    P6: if (step) st <= P7;
    P7: if (step) st <= P8;
    P8: if (step) st <= P9;
    P9: if (step) st <= P10;
    P10: if (step) st <= P11;
    P11: if (step) st <= P12;
    P12: if (step) st <= P13;
    P13: if (step) st <= P14;
    P14: if (step) st <= P15;
    P15: if (step) st <= P16;
    P16: if (step) st <= P17;
    P17: if (step) st <= P18;
    P18: if (step) st <= P19;
    P19: if (step) st <= P20;
    P20: if (step) st <= P21;
    P21: if (step) st <= P22;
    P22: if (step) st <= P23;
    P23: if (step) st <= P24;
    P24: if (step) st <= P25;
    P25: if (step) st <= P26;
    P26: if (step) st <= P27;
    P27: if (step) st <= P28;
    P28: if (step) st <= P29;
    P29: if (step) st <= P30;
    P30: if (step) st <= P31;
    P31: if (step) st <= P0;
  endcase
  always @* last = (st == P31);
endmodule
