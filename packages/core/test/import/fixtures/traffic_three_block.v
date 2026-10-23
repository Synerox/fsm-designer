// Moore traffic light, three always blocks, `define state codes, sync active-high reset.
`define S_MAIN_GREEN  2'b00
`define S_MAIN_YELLOW 2'b01
`define S_SIDE_GREEN  2'b10
`define S_SIDE_YELLOW 2'b11

module traffic_light (
  input  wire       clk,
  input  wire       rst,
  input  wire       car,
  input  wire       timer_done,
  output reg  [1:0] main_light,
  output reg  [1:0] side_light,
  output reg        timer_start
);
  reg [1:0] cs, ns;

  always @(posedge clk) begin
    if (rst) cs <= `S_MAIN_GREEN;
    else     cs <= ns;
  end

  always @(*) begin
    ns = cs;
    case (cs)
      `S_MAIN_GREEN:  if (car && timer_done) ns = `S_MAIN_YELLOW;
      `S_MAIN_YELLOW: if (timer_done)        ns = `S_SIDE_GREEN;
      `S_SIDE_GREEN:  if (timer_done || !car) ns = `S_SIDE_YELLOW;
      `S_SIDE_YELLOW: if (timer_done)        ns = `S_MAIN_GREEN;
      default:                               ns = `S_MAIN_GREEN;
    endcase
  end

  always @(*) begin
    main_light  = 2'd0;
    side_light  = 2'd0;
    timer_start = 1'b0;
    case (cs)
      `S_MAIN_GREEN:  main_light = 2'd2;
      `S_MAIN_YELLOW: begin main_light = 2'd1; timer_start = 1'b1; end
      `S_SIDE_GREEN:  side_light = 2'd2;
      `S_SIDE_YELLOW: begin side_light = 2'd1; timer_start = 1'b1; end
    endcase
  end
endmodule
